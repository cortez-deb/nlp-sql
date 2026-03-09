/**
 * core/SchemaEnricher.ts
 *
 * The SchemaEnricher orchestrates the one-time (or periodic) setup phase
 * of the nlsql library. It coordinates three other classes to produce
 * the enriched schema that powers the query engine:
 *
 *  1. MySQLAdapter     → read the raw schema from INFORMATION_SCHEMA
 *  2. BaseLLM          → send raw schema to the LLM, receive rich descriptions
 *  3. EnrichmentStore  → persist those rich descriptions to the database
 *
 * It also handles change detection — if a table's schema hasn't changed
 * since the last enrichment, it reuses the stored result instead of
 * making another expensive LLM API call.
 */

import type { MySQLAdapter } from '../db/MySQLAdapter';
import type { BaseLLM } from '../llm/BaseLLM';
import type { EnrichmentStore } from '../storage/EnrichmentStore';
import type { EnrichedTable, EnrichmentOptions, RawTable } from '../types';

/**
 * Progress information emitted during enrichment.
 * Useful for showing a progress bar or log messages in a CLI tool.
 */
export interface EnrichmentProgress {
  /** The table currently being processed. */
  tableName: string;

  /** How many tables have been processed so far. */
  completed: number;

  /** Total number of tables to process. */
  total: number;

  /**
   * Whether this table was freshly enriched (true) or
   * the stored enrichment was reused (false).
   */
  wasEnriched: boolean;
}

/**
 * Summary returned after the enrichment process completes.
 */
export interface EnrichmentSummary {
  /** Total number of tables that were examined. */
  totalTables: number;

  /** Number of tables that were newly enriched or re-enriched. */
  enriched: number;

  /** Number of tables that were skipped because their enrichment was up to date. */
  skipped: number;

  /** Names of any tables that failed enrichment (with error details logged). */
  failed: string[];

  /** Total time taken in milliseconds. */
  durationMs: number;
}

/**
 * SchemaEnricher orchestrates the full enrichment pipeline.
 *
 * Typical usage:
 *  1. Construct with the three dependencies (adapter, llm, store).
 *  2. Call `enrich()` once after initial setup.
 *  3. Call `enrich()` again whenever the schema changes.
 *  4. The query engine then uses `getEnrichedTables()` at query time.
 *
 * @example
 * const enricher = new SchemaEnricher(adapter, llm, store);
 *
 * const summary = await enricher.enrich({
 *   onProgress: (p) => console.log(`${p.completed}/${p.total}: ${p.tableName}`),
 * });
 *
 * console.log(`Enriched ${summary.enriched} tables, skipped ${summary.skipped}`);
 */
export class SchemaEnricher {
  private readonly adapter: MySQLAdapter;
  private readonly llm: BaseLLM;
  private readonly store: EnrichmentStore;

  /**
   * @param adapter - Open MySQLAdapter for schema introspection.
   * @param llm     - LLM instance for generating business descriptions.
   * @param store   - EnrichmentStore for persisting results.
   */
  constructor(adapter: MySQLAdapter, llm: BaseLLM, store: EnrichmentStore) {
    this.adapter = adapter;
    this.llm = llm;
    this.store = store;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Runs the full enrichment pipeline for all (or selected) tables.
   *
   * For each table:
   *  1. Read the raw schema from INFORMATION_SCHEMA.
   *  2. Collect sample values from each column.
   *  3. Compute a hash of the schema to detect changes.
   *  4. If the hash matches what's stored, skip (no LLM call needed).
   *  5. Otherwise, call the LLM to generate an enriched description.
   *  6. Store the result in the nlsql_enriched_schema table.
   *
   * @param options   - Controls which tables to enrich and other settings.
   * @param onProgress - Optional callback invoked after each table is processed.
   *                     Use this to display progress to the user.
   * @returns EnrichmentSummary with counts of enriched/skipped/failed tables.
   *
   * @example
   * const summary = await enricher.enrich(
   *   { forceRefresh: false },
   *   (p) => console.log(`Processing ${p.tableName} (${p.completed}/${p.total})`)
   * );
   */
  async enrich(
    options: EnrichmentOptions = {},
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<EnrichmentSummary> {
    const startTime = Date.now();
    const sampleSize = options.sampleSize ?? 5;
    const forceRefresh = options.forceRefresh ?? false;

    // ── Step 1: Read raw schema ────────────────────────────────────────────

    const rawTables = await this.adapter.getSchema(options.tables);

    if (rawTables.length === 0) {
      return {
        totalTables: 0,
        enriched: 0,
        skipped: 0,
        failed: [],
        durationMs: Date.now() - startTime,
      };
    }

    // ── Step 2: Load existing enrichments for change detection ─────────────

    const tableNames = rawTables.map((t) => t.tableName);
    const storedMap = await this.store.loadMany(tableNames);

    // ── Step 3: Process each table ─────────────────────────────────────────

    let enrichedCount = 0;
    let skippedCount = 0;
    const failedTables: string[] = [];

    for (let i = 0; i < rawTables.length; i++) {
      const rawTable = rawTables[i]!;
      const stored = storedMap.get(rawTable.tableName) ?? null;

      // Compute schema hash BEFORE sampling (sampling doesn't affect the hash)
      const { EnrichmentStore } = await import('../storage/EnrichmentStore');
      const schemaHash = EnrichmentStore.hashRawTable(rawTable);

      // Check if enrichment is still fresh
      const isFresh = !forceRefresh && this.store.isEnrichmentFresh(rawTable, stored);

      if (isFresh) {
        skippedCount++;
        onProgress?.({
          tableName: rawTable.tableName,
          completed: i + 1,
          total: rawTables.length,
          wasEnriched: false,
        });
        continue;
      }

      // ── Sample column values ─────────────────────────────────────────────

      const tableWithSamples = await this.addSamplesToTable(rawTable, sampleSize);

      // ── Call the LLM ─────────────────────────────────────────────────────

      try {
        const enriched = await this.llm.enrichTable(tableWithSamples, schemaHash);
        await this.store.save(enriched);
        enrichedCount++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[nlsql] Warning: Failed to enrich table "${rawTable.tableName}": ${message}`
        );
        failedTables.push(rawTable.tableName);
      }

      onProgress?.({
        tableName: rawTable.tableName,
        completed: i + 1,
        total: rawTables.length,
        wasEnriched: !failedTables.includes(rawTable.tableName),
      });
    }

    return {
      totalTables: rawTables.length,
      enriched: enrichedCount,
      skipped: skippedCount,
      failed: failedTables,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Retrieves all enriched table descriptions currently stored.
   * This is what the query engine calls at runtime to get schema context.
   *
   * @returns Array of all stored EnrichedTable objects.
   *
   * @example
   * const tables = await enricher.getEnrichedTables();
   * console.log(`${tables.length} tables available for querying`);
   */
  async getEnrichedTables(): Promise<EnrichedTable[]> {
    return this.store.loadAll();
  }

  /**
   * Finds the most relevant enriched tables for a given user query.
   *
   * Uses a simple keyword-based relevance scoring approach:
   *  - Matches the query words against table business names, descriptions,
   *    synonyms, and column synonyms.
   *  - Returns up to `maxTables` tables, sorted by relevance score.
   *
   * In a production system, this could be replaced with vector embedding
   * similarity search for even better results.
   *
   * @param userQuery  - The natural language query from the user.
   * @param maxTables  - Maximum number of tables to return.
   * @returns Array of the most relevant EnrichedTable objects.
   *
   * @example
   * const relevant = await enricher.findRelevantTables('show top customers', 5);
   */
  async findRelevantTables(
    userQuery: string,
    maxTables = 5
  ): Promise<EnrichedTable[]> {
    const allTables = await this.store.loadAll();

    if (allTables.length <= maxTables) {
      // If there are fewer tables than the limit, return all
      return allTables;
    }

    // Normalise the query: lowercase, split into individual words,
    // filter out very short words (a, an, the, is, etc.)
    const queryWords = userQuery
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);

    // Score each table by how many query words appear in its metadata
    const scored = allTables.map((table) => {
      const searchText = [
        table.tableName,
        table.businessName,
        table.description,
        table.synonyms.join(' '),
        table.useCases.join(' '),
        ...table.columns.flatMap((c) => [
          c.name,
          c.businessLabel,
          c.description,
          c.synonyms.join(' '),
          c.exampleQuestions.join(' '),
        ]),
      ]
        .join(' ')
        .toLowerCase();

      const score = queryWords.reduce((total, word) => {
        // Count occurrences of this word in the search text
        const occurrences = (searchText.match(new RegExp(`\\b${word}\\b`, 'g')) ?? []).length;
        return total + occurrences;
      }, 0);

      return { table, score };
    });

    // Sort by score descending, then alphabetically as a tiebreaker
    scored.sort((a, b) => b.score - a.score || a.table.tableName.localeCompare(b.table.tableName));

    // Return just the table objects for the top N results
    return scored.slice(0, maxTables).map((s) => s.table);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Enriches a RawTable's columns with sample values from the actual data.
   * Sample values give the LLM crucial context about what kind of data
   * lives in each column (e.g. enum values, ID formats, date ranges).
   *
   * @param rawTable  - The table to add samples to.
   * @param sampleSize - How many distinct values to fetch per column.
   * @returns A new RawTable with `sampleValues` populated on each column.
   */
  private async addSamplesToTable(
    rawTable: RawTable,
    sampleSize: number
  ): Promise<RawTable> {
    const columnsWithSamples = await Promise.all(
      rawTable.columns.map(async (col) => {
        // Skip binary/blob columns — they can't be meaningfully sampled as text
        const skipTypes = ['blob', 'longblob', 'mediumblob', 'tinyblob', 'binary', 'varbinary'];
        if (skipTypes.includes(col.dataType.toLowerCase())) {
          return col;
        }

        const sampleValues = await this.adapter.sampleColumn(
          rawTable.tableName,
          col.columnName,
          sampleSize
        );

        return { ...col, sampleValues };
      })
    );

    return { ...rawTable, columns: columnsWithSamples };
  }
}
