/**
 * core/NLSQLClient.ts
 *
 * NLSQLClient is the main entry point for users of the nlsql library.
 * It's the only class users need to import and use directly.
 *
 * It coordinates all the other classes internally:
 *  - MySQLAdapter     → database connection & query execution
 *  - GeminiLLM        → LLM integration
 *  - EnrichmentStore  → persistent storage of enriched schema
 *  - SchemaEnricher   → orchestrates the enrichment pipeline
 *  - SQLValidator     → ensures generated SQL is safe to run
 *
 * Usage flow:
 *  1. Create an NLSQLClient with your DB and LLM config.
 *  2. Call `initialise()` once (sets up storage, enriches schema).
 *  3. Call `query('your question in plain English')` as many times as needed.
 *  4. Call `close()` when done.
 */

import { MySQLAdapter } from '../db/MySQLAdapter';
import { GeminiLLM } from '../llm/GeminiLLM';
import { OpenAILLM } from '../llm/OpenAILLM';
import { OllamaLLM } from '../llm/OllamaLLM';
import { BaseLLM } from '../llm/BaseLLM';
import { EnrichmentStore } from '../storage/EnrichmentStore';
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

/**
 * Configuration passed to the NLSQLClient constructor.
 */
export interface NLSQLClientConfig {
  /**
   * MySQL database connection details.
   * This should be a READ-ONLY user for safety.
   *
   * @example
   * db: {
   *   host: 'localhost',
   *   user: 'nlsql_readonly',
   *   password: process.env.DB_PASSWORD!,
   *   database: 'my_app',
   * }
   */
  db: MySQLConnectionConfig;

  /**
   * Configuration for the LLM (AI model) used to understand natural language
   * and generate SQL queries.
   *
   * @example
   * llm: {
   *   provider: 'gemini',
   *   apiKey: process.env.GEMINI_API_KEY!,
   *   model: 'gemini-1.5-flash-latest',
   * }
   */
  llm: LLMConfig;
}

/**
 * NLSQLClient is the main class of the nlsql library.
 *
 * It allows you to query a MySQL database using plain English questions.
 * Internally it uses a Gemini LLM to understand the question and generate SQL,
 * validates the SQL for safety, and then executes it against the database.
 *
 * @example
 * // Create the client
 * const client = new NLSQLClient({
 *   db: {
 *     host: 'localhost',
 *     user: 'readonly_user',
 *     password: process.env.DB_PASSWORD!,
 *     database: 'shop',
 *   },
 *   llm: {
 *     provider: 'gemini',
 *     apiKey: process.env.GEMINI_API_KEY!,
 *     model: 'gemini-1.5-flash-latest',
 *   },
 * });
 *
 * // Set up (once on startup)
 * await client.initialise();
 *
 * // Query in plain English
 * const result = await client.query('Show me the top 10 customers by total spend');
 * if (result.error) {
 *   console.error('Query failed:', result.error);
 * } else {
 *   console.log('SQL:', result.sql);
 *   console.log('Results:', result.results);
 * }
 *
 * // Clean up when done
 * await client.close();
 */
export class NLSQLClient {
  /** The database adapter — handles all MySQL communication. */
  private adapter!: MySQLAdapter;

  /** The LLM — handles natural language understanding and SQL generation. */
  private llm!: BaseLLM;

  /** Persists enriched schema descriptions between runs. */
  private store!: EnrichmentStore;

  /** Orchestrates the schema enrichment pipeline. */
  private enricher!: SchemaEnricher;

  /** Validates all LLM-generated SQL before execution. */
  private readonly validator: SQLValidator;

  /** The user's configuration, stored for reference. */
  private readonly config: NLSQLClientConfig;

  /**
   * Whether `initialise()` has been called successfully.
   * Guards against calling `query()` before setup is complete.
   */
  private initialised = false;

  /**
   * Creates a new NLSQLClient.
   *
   * Note: This constructor is synchronous and lightweight. The actual
   * database connection and enrichment setup happens in `initialise()`.
   *
   * @param config - Database and LLM configuration.
   */
  constructor(config: NLSQLClientConfig) {
    this.config = config;
    this.validator = new SQLValidator();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SETUP
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialises the client. Must be called once before `query()`.
   *
   * This method:
   *  1. Opens a MySQL connection pool and verifies connectivity.
   *  2. Creates the enrichment storage table if it doesn't exist.
   *  3. Optionally runs schema enrichment (if `enrichOptions` is provided).
   *
   * @param enrichOptions - If provided, automatically runs schema enrichment
   *                        during initialisation. Omit to skip enrichment
   *                        (useful if you've already enriched previously).
   * @param onProgress    - Optional progress callback for enrichment.
   * @returns EnrichmentSummary if enrichment ran, null otherwise.
   *
   * @example
   * // First run: enrich the schema
   * await client.initialise({ forceRefresh: false }, (p) => {
   *   console.log(`Enriching ${p.tableName}... (${p.completed}/${p.total})`);
   * });
   *
   * // Subsequent runs: skip enrichment (use cached enrichments)
   * await client.initialise();
   */
  async initialise(
    enrichOptions?: EnrichmentOptions,
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<EnrichmentSummary | null> {
    // ── Connect to MySQL ────────────────────────────────────────────────────
    this.adapter = await MySQLAdapter.create(this.config.db);

    // ── Instantiate the LLM provider ────────────────────────────────────────
    this.llm = NLSQLClient.createLLM(this.config.llm);

    // ── Set up enrichment storage ───────────────────────────────────────────
    this.store = new EnrichmentStore(this.adapter);
    await this.store.initialise();

    // ── Wire up the enricher ────────────────────────────────────────────────
    this.enricher = new SchemaEnricher(this.adapter, this.llm, this.store);

    this.initialised = true;

    // ── Optionally run enrichment ────────────────────────────────────────────
    if (enrichOptions !== undefined) {
      return this.enrich(enrichOptions, onProgress);
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENRICHMENT
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Runs the schema enrichment pipeline.
   *
   * Call this on first setup, and again whenever your database schema changes.
   * After enrichment, `query()` will work correctly.
   *
   * @param options    - Enrichment options (force refresh, specific tables, etc.).
   * @param onProgress - Optional callback to track progress.
   * @returns Summary of what was enriched, skipped, or failed.
   *
   * @example
   * const summary = await client.enrich({ forceRefresh: true });
   * console.log(`Enriched: ${summary.enriched}, Skipped: ${summary.skipped}`);
   */
  async enrich(
    options: EnrichmentOptions = {},
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<EnrichmentSummary> {
    this.assertInitialised('enrich');
    return this.enricher.enrich(options, onProgress);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // QUERYING
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Translates a natural language question into SQL and executes it.
   *
   * The full pipeline runs on each call:
   *  1. Find the most relevant enriched tables for the question.
   *  2. Build a prompt with schema context and (optional) examples.
   *  3. Send the prompt to the configured LLM to generate SQL.
   *  4. Validate the SQL (keyword blocklist + structural check).
   *  5. Execute the validated SQL and return results.
   *
   * Always check `result.error` before using `result.results`.
   *
   * @param question - A plain English question about your data.
   *                   Examples:
   *                   - "How many customers signed up last month?"
   *                   - "Show me the top 10 products by revenue"
   *                   - "Which orders are still pending?"
   * @param options  - Optional settings (few-shot examples, row limit, etc.)
   * @returns QueryResult with sql, results, error, and timing information.
   *
   * @example
   * const result = await client.query('Who are our top 5 customers?', {
   *   fewShotExamples: [
   *     {
   *       question: 'Show all customers',
   *       sql: 'SELECT customers.id, customers.name FROM customers LIMIT 100',
   *     }
   *   ],
   *   maxRows: 5,
   * });
   *
   * if (result.error) {
   *   console.error(result.error);
   * } else {
   *   console.table(result.results);
   * }
   */
  async query(
    question: string,
    options: QueryOptions = {}
  ): Promise<QueryResult> {
    this.assertInitialised('query');

    const startTime = Date.now();
    const maxRows = options.maxRows ?? 1000;
    const maxContextTables = options.maxContextTables ?? 5;

    // ── Step 1: Retrieve relevant schema context ────────────────────────────
    const retrievalStart = Date.now();
    let contextTables: EnrichedTable[];
    try {
      contextTables = await this.enricher.findRelevantTables(question, maxContextTables);
    } catch (err) {
      return this.errorResult(
        `Failed to retrieve schema context: ${err instanceof Error ? err.message : String(err)}`,
        startTime
      );
    }

    if (contextTables.length === 0) {
      return this.errorResult(
        'No enriched schema found. Please run client.enrich() before querying.',
        startTime
      );
    }
    const retrievalMs = Date.now() - retrievalStart;

    // ── Step 2: Generate SQL ────────────────────────────────────────────────
    const generationStart = Date.now();
    let rawSQL: string;
    try {
      rawSQL = await this.llm.generateSQL(
        question,
        contextTables,
        options.fewShotExamples ?? []
      );
    } catch (err) {
      return this.errorResult(
        `LLM SQL generation failed: ${err instanceof Error ? err.message : String(err)}`,
        startTime,
        retrievalMs
      );
    }
    const generationMs = Date.now() - generationStart;

    // ── Step 3: Validate the generated SQL ─────────────────────────────────
    const validationStart = Date.now();
    const validation = this.validator.validate(rawSQL);
    const validationMs = Date.now() - validationStart;

    if (!validation.isValid) {
      return {
        sql: rawSQL,
        results: null,
        error: validation.reason,
        timing: {
          retrievalMs,
          generationMs,
          validationMs,
          executionMs: 0,
          totalMs: Date.now() - startTime,
        },
      };
    }

    // ── Step 4: Execute the SQL ─────────────────────────────────────────────
    const executionStart = Date.now();
    let results: Record<string, unknown>[];
    try {
      results = await this.adapter.executeQuery(rawSQL, maxRows);
    } catch (err) {
      const executionMs = Date.now() - executionStart;
      return {
        sql: rawSQL,
        results: null,
        error: `Query execution failed: ${err instanceof Error ? err.message : String(err)}`,
        timing: {
          retrievalMs,
          generationMs,
          validationMs,
          executionMs,
          totalMs: Date.now() - startTime,
        },
      };
    }
    const executionMs = Date.now() - executionStart;

    return {
      sql: rawSQL,
      results,
      error: null,
      timing: {
        retrievalMs,
        generationMs,
        validationMs,
        executionMs,
        totalMs: Date.now() - startTime,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INTROSPECTION
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns all currently enriched table descriptions.
   * Useful for debugging — you can inspect what the LLM knows about your schema.
   *
   * @example
   * const tables = await client.getEnrichedSchema();
   * for (const table of tables) {
   *   console.log(`${table.tableName} → ${table.businessName}`);
   * }
   */
  async getEnrichedSchema(): Promise<EnrichedTable[]> {
    this.assertInitialised('getEnrichedSchema');
    return this.enricher.getEnrichedTables();
  }

  /**
   * Validates a SQL string without executing it.
   * Useful for testing your own SQL or debugging the validator.
   *
   * @param sql - The SQL string to validate.
   * @returns Validation result with isValid and optional reason.
   *
   * @example
   * const result = client.validateSQL('DELETE FROM users');
   * // result.isValid === false
   * // result.reason  === 'Blocked keyword detected: DELETE'
   */
  validateSQL(sql: string) {
    return this.validator.validate(sql);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEARDOWN
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Closes the database connection pool and releases all resources.
   * Always call this when the client is no longer needed to avoid
   * leaving open database connections.
   *
   * @example
   * await client.close();
   */
  async close(): Promise<void> {
    if (this.adapter) {
      await this.adapter.close();
    }
    this.initialised = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Factory method that creates the correct LLM instance based on the provider
   * specified in the config.
   *
   * Supported providers:
   *  - 'gemini' → GeminiLLM  (Google Gemini API)
   *  - 'openai' → OpenAILLM  (OpenAI GPT API, or any OpenAI-compatible endpoint)
   *  - 'ollama' → OllamaLLM  (Local Ollama server, no API key needed)
   *
   * @param config - LLM configuration including provider, apiKey, and model.
   * @returns A concrete BaseLLM subclass instance.
   * @throws Error if an unsupported provider is specified.
   */
  private static createLLM(config: LLMConfig): BaseLLM {
    switch (config.provider) {
      case 'gemini':
        return new GeminiLLM(config);

      case 'openai':
        return new OpenAILLM(config);

      case 'ollama':
        // OllamaConfig extends LLMConfig with an optional baseURL field.
        // Cast is safe because 'ollama' provider is only used with OllamaConfig.
        return new OllamaLLM(config);

      default: {
        // TypeScript exhaustiveness check — if you add a new LLMProvider to
        // the union type in types/index.ts but forget to handle it here,
        // TypeScript will give a compile error on the line below.
        const _exhaustive: never = config.provider;
        throw new Error(
          `[nlsql] Unsupported LLM provider: "${_exhaustive}". ` +
          `Supported providers: "gemini", "openai", "ollama"`
        );
      }
    }
  }

  /**
   * Throws an error if `initialise()` has not been called yet.
   * Provides a clear, actionable error message.
   *
   * @param methodName - The name of the method that requires initialisation.
   */
  private assertInitialised(methodName: string): void {
    if (!this.initialised) {
      throw new Error(
        `[nlsql] NLSQLClient.${methodName}() was called before initialise(). ` +
        `Please call await client.initialise() first.`
      );
    }
  }

  /**
   * Constructs a failed QueryResult with a consistent shape.
   * Used when any step in the query pipeline fails.
   *
   * @param error       - Description of what went wrong.
   * @param startTime   - Unix timestamp (ms) when the query started.
   * @param retrievalMs - Time spent on retrieval (if it completed).
   * @param generationMs - Time spent on generation (if it completed).
   */
  private errorResult(
    error: string,
    startTime: number,
    retrievalMs = 0,
    generationMs = 0
  ): QueryResult {
    return {
      sql: null,
      results: null,
      error,
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
