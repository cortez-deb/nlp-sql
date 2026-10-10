/**
 * core/NLSQLClient.ts
 *
 * NLSQLClient is the main entry point for users of the nlsql library.
 */

import { MySQLAdapter } from '../db/MySQLAdapter';
import type { RowStream } from '../db/MySQLAdapter';
import { SqlRejectedError } from './errors';
import { GeminiLLM } from '../llm/GeminiLLM';
import { BaseLLM } from '../llm/BaseLLM';
import type { IEnrichmentStore } from '../storage/IEnrichmentStore';
import { FileEnrichmentStore } from '../storage/FileEnrichmentStore';
import { MySQLEnrichmentStore } from '../storage/EnrichmentStore';
import { SchemaEnricher } from './SchemaEnricher';
import { SQLValidator } from '../validation/SQLValidator';

import type {
  MySQLConnectionConfig,
  LLMConfig,
  QueryResult,
  QueryOptions,
  EnrichmentOptions,
  EnrichedTable,
} from '../types';

import type { EnrichmentSummary, EnrichmentProgress } from './SchemaEnricher';

export interface NLSQLClientConfig {
  db: MySQLConnectionConfig;
  llm: LLMConfig;
  storage?:
    | { type: 'file'; path?: string }
    | { type: 'mysql'; admin?: MySQLConnectionConfig };
  security?: { queryTimeoutMs?: number; maxRows?: number };
  schema?: { excludeTables?: string[]; excludeColumns?: string[] };
  /** Defaults used by openRowStream() (CSV export). */
  export?: { timeoutMs?: number };
}

const RETRYABLE_CODES = new Set([
  'ER_BAD_FIELD_ERROR',
  'ER_NO_SUCH_TABLE',
  'ER_PARSE_ERROR',
  'ER_WRONG_VALUE_COUNT_ON_ROW',
  'ER_NON_UNIQ_ERROR',
  'ER_WRONG_FIELD_WITH_GROUP',
]);

const RETRYABLE_ERRNOS = new Set([1054, 1146, 1064, 1136, 1052, 1055]);

function isRetryableMySQLError(err: any): boolean {
  if (!err) return false;
  if (err.code && RETRYABLE_CODES.has(String(err.code))) return true;
  if (err.errno && RETRYABLE_ERRNOS.has(Number(err.errno))) return true;
  return false;
}

export class NLSQLClient {
  private adapter!: MySQLAdapter;
  private adminAdapter?: MySQLAdapter;
  private llm!: BaseLLM;
  private store!: IEnrichmentStore;
  private enricher!: SchemaEnricher;
  private readonly validator: SQLValidator;
  private readonly config: NLSQLClientConfig;
  private initialised = false;

  constructor(config: NLSQLClientConfig) {
    this.config = config;
    this.validator = new SQLValidator();
  }

  async initialise(
    enrichOptions?: EnrichmentOptions,
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<EnrichmentSummary | null> {
    this.adapter = await MySQLAdapter.create(this.config.db);
    this.llm = NLSQLClient.createLLM(this.config.llm);

    const storageConfig = this.config.storage ?? { type: 'file', path: './.nlsql/enrichment.json' };

    if (storageConfig.type === 'mysql') {
      if (storageConfig.admin) {
        this.adminAdapter = await MySQLAdapter.create(storageConfig.admin);
        this.store = new MySQLEnrichmentStore(this.adminAdapter);
      } else {
        this.store = new MySQLEnrichmentStore(this.adapter);
      }
    } else {
      this.store = new FileEnrichmentStore(storageConfig.path ?? './.nlsql/enrichment.json');
    }

    await this.store.initialise();

    this.enricher = new SchemaEnricher(
      this.adapter,
      this.llm,
      this.store,
      this.config.schema
    );

    this.initialised = true;

    if (enrichOptions !== undefined) {
      return this.enrich(enrichOptions, onProgress);
    }

    return null;
  }

  async enrich(
    options: EnrichmentOptions = {},
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<EnrichmentSummary> {
    this.assertInitialised('enrich');
    return this.enricher.enrich(options, onProgress);
  }

  async query(
    question: string,
    options: QueryOptions = {}
  ): Promise<QueryResult> {
    this.assertInitialised('query');

    const startTime = Date.now();
    const maxRows = options.maxRows ?? this.config.security?.maxRows ?? 1000;
    const maxContextTables = options.maxContextTables ?? 5;
    const maxRetries = options.maxRetries ?? 2;
    const queryTimeoutMs = options.timeoutMs ?? this.config.security?.queryTimeoutMs ?? 10000;

    // ── Step 1: Retrieve schema context ──────────────────────────────────────
    const retrievalStart = Date.now();
    let allEnrichedTables: EnrichedTable[];
    try {
      allEnrichedTables = await this.enricher.getEnrichedTables();
    } catch (err) {
      return this.errorResult(
        `Failed to retrieve schema context: ${err instanceof Error ? err.message : String(err)}`,
        startTime
      );
    }

    if (allEnrichedTables.length === 0) {
      return this.errorResult(
        'No enriched schema found. Please run client.enrich() before querying.',
        startTime
      );
    }

    let contextTables: EnrichedTable[];
    if (allEnrichedTables.length <= 12) {
      contextTables = allEnrichedTables;
    } else {
      contextTables = await this.enricher.findRelevantTables(question, maxContextTables);
    }
    const retrievalMs = Date.now() - retrievalStart;

    const allowedTables = allEnrichedTables.map((t) => t.tableName);

    // ── Step 2: Retry Loop for Generation, Validation, and Execution ────────
    let attempts = 0;
    let previousAttempt: { sql: string; error: string } | undefined;
    let lastSQL: string | null = null;
    let generationMs = 0;
    let validationMs = 0;
    let executionMs = 0;

    let successfulRows: Record<string, unknown>[] | null = null;
    let isTruncated = false;

    while (attempts <= maxRetries) {
      attempts++;

      // Generation
      const genStart = Date.now();
      let sql: string;
      try {
        sql = await this.llm.generateSQL({
          question,
          contextTables,
          fewShotExamples: options.fewShotExamples ?? [],
          dialect: options.dialect ?? 'mysql',
          history: options.history ?? [],
          previousAttempt,
        });
      } catch (err) {
        generationMs += Date.now() - genStart;
        return this.errorResult(
          `LLM SQL generation failed: ${err instanceof Error ? err.message : String(err)}`,
          startTime,
          retrievalMs,
          generationMs,
          attempts
        );
      }
      generationMs += Date.now() - genStart;
      lastSQL = sql;

      // Validation
      const valStart = Date.now();
      const validation = this.validator.validate(sql, {
        allowedTables,
        allowedDatabase: this.config.db.database,
      });
      validationMs += Date.now() - valStart;

      if (!validation.isValid) {
        if (validation.kind === 'unable' || validation.kind === 'empty') {
          return {
            sql,
            results: null,
            error: validation.reason,
            attempts,
            truncated: false,
            rowCount: 0,
            timing: {
              retrievalMs,
              generationMs,
              validationMs,
              executionMs,
              totalMs: Date.now() - startTime,
            },
          };
        }
        previousAttempt = { sql, error: validation.reason || 'Validation failed' };
        continue;
      }

      // Execution
      const execStart = Date.now();
      try {
        const execRes = await this.adapter.executeQuery(sql, maxRows, {
          hasTopLevelLimit: validation.hasTopLevelLimit,
          timeoutMs: queryTimeoutMs,
        });
        executionMs += Date.now() - execStart;
        successfulRows = execRes.rows;
        isTruncated = execRes.truncated;
        break;
      } catch (err) {
        executionMs += Date.now() - execStart;
        const errMsg = err instanceof Error ? err.message : String(err);

        if (isRetryableMySQLError(err)) {
          previousAttempt = { sql, error: errMsg };
          continue;
        } else {
          return {
            sql,
            results: null,
            error: `Query execution failed: ${errMsg}`,
            attempts,
            truncated: false,
            rowCount: 0,
            timing: {
              retrievalMs,
              generationMs,
              validationMs,
              executionMs,
              totalMs: Date.now() - startTime,
            },
          };
        }
      }
    }

    if (successfulRows === null) {
      return {
        sql: lastSQL,
        results: null,
        error: previousAttempt
          ? `Query failed after ${attempts} attempts. Last error: ${previousAttempt.error}`
          : 'Query failed to generate valid SQL.',
        attempts,
        truncated: false,
        rowCount: 0,
        timing: {
          retrievalMs,
          generationMs,
          validationMs,
          executionMs,
          totalMs: Date.now() - startTime,
        },
      };
    }

    // ── Step 3: Summarization (if requested) ───────────────────────────────
    let summary: string | undefined;
    let summaryMs: number | undefined;

    if (options.summarize) {
      if (successfulRows.length === 0) {
        summary = 'No matching records found.';
      } else {
        const summaryStart = Date.now();
        const truncatedForSummary = successfulRows.slice(0, 30).map((row) => {
          const newRow: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row)) {
            const s = String(v ?? '');
            newRow[k] = s.length > 100 ? s.slice(0, 100) + '...' : v;
          }
          return newRow;
        });

        try {
          summary = await this.llm.summarizeResult({
            question,
            sql: lastSQL!,
            rows: truncatedForSummary,
            totalRowCount: successfulRows.length,
            truncated: isTruncated,
            maxChars: options.summaryMaxChars ?? 600,
          });
          summaryMs = Date.now() - summaryStart;
        } catch {
          // If summarization fails, leave summary undefined and return results
        }
      }
    }

    const columns =
      successfulRows.length > 0 ? Object.keys(successfulRows[0]!) : undefined;

    return {
      sql: lastSQL,
      results: successfulRows,
      error: null,
      attempts,
      truncated: isTruncated,
      rowCount: successfulRows.length,
      summary,
      columns,
      timing: {
        retrievalMs,
        generationMs,
        validationMs,
        executionMs,
        summaryMs,
        totalMs: Date.now() - startTime,
      },
    };
  }

  async getEnrichedSchema(): Promise<EnrichedTable[]> {
    this.assertInitialised('getEnrichedSchema');
    return this.enricher.getEnrichedTables();
  }

  /**
   * Re-validates `sql` and opens it as a row stream (no LIMIT is appended; the
   * caller enforces any cap while reading). Throws SqlRejectedError if the SQL
   * fails validation, before any connection is taken.
   *
   * Always re-validates: never trust SQL that was stored in chat state.
   */
  async openRowStream(sql: string, opts?: { timeoutMs?: number }): Promise<RowStream> {
    this.assertInitialised('openRowStream');

    const allowedTables = (await this.enricher.getEnrichedTables()).map((t) => t.tableName);
    const validation = this.validator.validate(sql, {
      allowedTables,
      allowedDatabase: this.config.db.database,
    });
    if (!validation.isValid) {
      throw new SqlRejectedError(validation.reason ?? 'SQL rejected', validation.kind);
    }

    const timeoutMs = opts?.timeoutMs ?? this.config.export?.timeoutMs ?? 60_000;
    return this.adapter.openStream(sql, { timeoutMs });
  }

  validateSQL(sql: string) {
    return this.validator.validate(sql);
  }

  async close(): Promise<void> {
    if (this.adapter) {
      await this.adapter.close().catch(() => {});
    }
    if (this.adminAdapter) {
      await this.adminAdapter.close().catch(() => {});
    }
    this.initialised = false;
  }

  private static createLLM(config: LLMConfig): BaseLLM {
    switch (config.provider) {
      case 'gemini':
        return new GeminiLLM(config);

      default: {
        const _exhaustive: never = config.provider;
        throw new Error(
          `[nlsql] Unsupported LLM provider: "${_exhaustive}". Supported providers: "gemini"`
        );
      }
    }
  }

  private assertInitialised(methodName: string): void {
    if (!this.initialised) {
      throw new Error(
        `[nlsql] NLSQLClient.${methodName}() was called before initialise(). ` +
          `Please call await client.initialise() first.`
      );
    }
  }

  private errorResult(
    error: string,
    startTime: number,
    retrievalMs = 0,
    generationMs = 0,
    attempts = 0
  ): QueryResult {
    return {
      sql: null,
      results: null,
      error,
      attempts,
      truncated: false,
      rowCount: 0,
      timing: {
        retrievalMs,
        generationMs,
        validationMs: 0,
        executionMs: 0,
        totalMs: Date.now() - startTime,
      },
    };
  }
}
