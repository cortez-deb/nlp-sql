/**
 * storage/EnrichmentStore.ts
 *
 * This class manages persisting the LLM-enriched schema descriptions
 * between runs of the library. Without persistence, the library would
 * have to call the LLM to re-describe every table on every startup —
 * which is slow and expensive.
 *
 * Storage strategy: A dedicated table called `nlsql_enriched_schema`
 * is created in the SAME MySQL database that is being queried. This
 * keeps everything in one place — no extra infrastructure needed.
 *
 * Schema of the storage table:
 *   - table_name   : The database table this row describes
 *   - enriched_json: The full EnrichedTable object, serialised as JSON
 *   - schema_hash  : A hash of the raw schema at enrichment time (for change detection)
 *   - enriched_at  : When this enrichment was generated
 */

import crypto from 'crypto';
import type { RowDataPacket } from 'mysql2';
import type { MySQLAdapter } from '../db/MySQLAdapter';
import type { EnrichedTable, RawTable } from '../types';

/**
 * The name of the MySQL table used to store enrichments.
 * Prefixed with "nlsql_" to make it easy to identify as library-managed.
 */
const STORAGE_TABLE = 'nlsql_enriched_schema';

/**
 * EnrichmentStore handles reading and writing enriched table descriptions
 * to a MySQL table. It acts as a cache layer between the expensive LLM
 * enrichment step and the runtime query pipeline.
 *
 * The store uses schema hashing to detect when a table's structure has
 * changed, so stale enrichments are automatically flagged for refresh.
 *
 * @example
 * const store = new EnrichmentStore(adapter);
 * await store.initialise();             // creates the storage table if needed
 * await store.save(enrichedTable);      // persist an enrichment
 * const table = await store.load('orders'); // retrieve an enrichment
 */
export class EnrichmentStore {
  /**
   * The MySQLAdapter used for all database operations.
   * We reuse the same connection pool as the rest of the library.
   */
  private readonly adapter: MySQLAdapter;

  /**
   * Creates a new EnrichmentStore.
   * Call `initialise()` after construction before using other methods.
   *
   * @param adapter - An open MySQLAdapter connected to the target database.
   */
  constructor(adapter: MySQLAdapter) {
    this.adapter = adapter;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SETUP
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Ensures the storage table exists in the database.
   * Uses "CREATE TABLE IF NOT EXISTS" so it is safe to call on every startup —
   * if the table already exists, nothing happens.
   *
   * This should be called once before any other method.
   *
   * @example
   * const store = new EnrichmentStore(adapter);
   * await store.initialise();
   */
  async initialise(): Promise<void> {
    await this.adapter.rawQuery(`
      CREATE TABLE IF NOT EXISTS \`${STORAGE_TABLE}\` (
        \`table_name\`    VARCHAR(255) NOT NULL,
        \`enriched_json\` LONGTEXT     NOT NULL,
        \`schema_hash\`   VARCHAR(64)  NOT NULL,
        \`enriched_at\`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`table_name\`),
        INDEX \`idx_enriched_at\` (\`enriched_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Managed by nlsql — stores LLM-enriched schema descriptions'
    `);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WRITE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Saves or updates an enriched table description in the storage table.
   *
   * Uses MySQL's "INSERT ... ON DUPLICATE KEY UPDATE" pattern, which inserts
   * a new row if the table_name doesn't exist yet, or updates the existing
   * row if it does. This is an "upsert" — insert or update.
   *
   * @param enriched - The fully populated EnrichedTable object to persist.
   *
   * @example
   * await store.save({
   *   tableName: 'orders',
   *   businessName: 'Customer Orders',
   *   description: 'Stores every purchase...',
   *   // ...
   * });
   */
  async save(enriched: EnrichedTable): Promise<void> {
    const json = JSON.stringify(enriched);

    await this.adapter.rawQuery(
      `INSERT INTO \`${STORAGE_TABLE}\`
         (\`table_name\`, \`enriched_json\`, \`schema_hash\`, \`enriched_at\`)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         \`enriched_json\` = VALUES(\`enriched_json\`),
         \`schema_hash\`   = VALUES(\`schema_hash\`),
         \`enriched_at\`   = NOW()`,
      [enriched.tableName, json, enriched.schemaHash]
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // READ
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Loads a single enriched table description from the storage table.
   *
   * @param tableName - The technical name of the table (e.g. "orders").
   * @returns The EnrichedTable if found, or null if not yet enriched.
   *
   * @example
   * const enriched = await store.load('orders');
   * if (enriched === null) {
   *   console.log('orders has not been enriched yet');
   * }
   */
  async load(tableName: string): Promise<EnrichedTable | null> {
    const rows = await this.adapter.rawQuery<RowDataPacket[]>(
      `SELECT \`enriched_json\` FROM \`${STORAGE_TABLE}\` WHERE \`table_name\` = ? LIMIT 1`,
      [tableName]
    );

    if (rows.length === 0) return null;

    try {
      return JSON.parse(rows[0]!['enriched_json'] as string) as EnrichedTable;
    } catch {
      // If the stored JSON is corrupted, treat it as non-existent
      return null;
    }
  }

  /**
   * Loads all enriched table descriptions from the storage table.
   *
   * @returns An array of all stored EnrichedTable objects. Empty if none exist.
   *
   * @example
   * const allEnriched = await store.loadAll();
   * console.log(`Found ${allEnriched.length} enriched tables`);
   */
  async loadAll(): Promise<EnrichedTable[]> {
    const rows = await this.adapter.rawQuery<RowDataPacket[]>(
      `SELECT \`enriched_json\` FROM \`${STORAGE_TABLE}\` ORDER BY \`table_name\``
    );

    const results: EnrichedTable[] = [];
    for (const row of rows) {
      try {
        results.push(JSON.parse(row['enriched_json'] as string) as EnrichedTable);
      } catch {
        // Skip any corrupted rows silently
      }
    }
    return results;
  }

  /**
   * Loads enriched descriptions for a specific list of table names.
   *
   * @param tableNames - Array of table names to load.
   * @returns Map from table name to EnrichedTable (only includes tables that exist in store).
   *
   * @example
   * const map = await store.loadMany(['orders', 'customers']);
   * const ordersEnriched = map.get('orders');
   */
  async loadMany(tableNames: string[]): Promise<Map<string, EnrichedTable>> {
    if (tableNames.length === 0) return new Map();

    const placeholders = tableNames.map(() => '?').join(', ');
    const rows = await this.adapter.rawQuery<RowDataPacket[]>(
      `SELECT \`table_name\`, \`enriched_json\`
       FROM \`${STORAGE_TABLE}\`
       WHERE \`table_name\` IN (${placeholders})`,
      tableNames
    );

    const result = new Map<string, EnrichedTable>();
    for (const row of rows) {
      try {
        const enriched = JSON.parse(row['enriched_json'] as string) as EnrichedTable;
        result.set(row['table_name'] as string, enriched);
      } catch {
        // Skip corrupted rows
      }
    }
    return result;
  }

  /**
   * Deletes the enrichment record for a single table.
   * Useful when you want to force re-enrichment of a specific table.
   *
   * @param tableName - The table whose enrichment should be deleted.
   *
   * @example
   * await store.delete('orders');
   * // Next call to enrich() will re-process 'orders' from scratch
   */
  async delete(tableName: string): Promise<void> {
    await this.adapter.rawQuery(
      `DELETE FROM \`${STORAGE_TABLE}\` WHERE \`table_name\` = ?`,
      [tableName]
    );
  }

  /**
   * Deletes ALL enrichment records.
   * Use this when you want to force a complete re-enrichment of the entire schema.
   *
   * @example
   * await store.clear();
   */
  async clear(): Promise<void> {
    await this.adapter.rawQuery(`DELETE FROM \`${STORAGE_TABLE}\``);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CHANGE DETECTION
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Determines whether a table's raw schema has changed since it was
   * last enriched, by comparing hashes.
   *
   * If the schema has changed (new columns, renamed columns, changed types),
   * the stored enrichment is stale and should be regenerated.
   *
   * @param rawTable - The current raw schema for the table.
   * @param stored   - The previously stored enrichment (if any).
   * @returns true if the stored enrichment is still valid; false if it needs refresh.
   *
   * @example
   * const stored = await store.load('orders');
   * const isValid = store.isEnrichmentFresh(currentRawTable, stored);
   * if (!isValid) {
   *   // Re-enrich this table
   * }
   */
  isEnrichmentFresh(rawTable: RawTable, stored: EnrichedTable | null): boolean {
    if (stored === null) return false;
    const currentHash = EnrichmentStore.hashRawTable(rawTable);
    return currentHash === stored.schemaHash;
  }

  /**
   * Computes a deterministic hash of a RawTable's structure.
   *
   * The hash is based on: table name, column names, column types, and
   * nullable flags. If any of these change, the hash changes, signalling
   * that re-enrichment is needed.
   *
   * @param rawTable - The raw table to hash.
   * @returns A 64-character hex SHA-256 hash string.
   */
  static hashRawTable(rawTable: RawTable): string {
    // Build a stable string representation of the schema.
    // We sort columns by ordinal position to ensure consistent ordering.
    const schemaSignature = {
      tableName: rawTable.tableName,
      columns: [...rawTable.columns]
        .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
        .map((c) => ({
          name: c.columnName,
          type: c.dataType,
          nullable: c.isNullable,
          key: c.columnKey,
        })),
      foreignKeys: rawTable.foreignKeys
        .map((fk) => `${fk.columnName}->${fk.referencedTable}.${fk.referencedColumn}`)
        .sort(), // sort for stability
    };

    return crypto
      .createHash('sha256')
      .update(JSON.stringify(schemaSignature))
      .digest('hex');
  }
}
