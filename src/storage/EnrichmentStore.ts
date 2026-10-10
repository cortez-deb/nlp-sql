/**
 * storage/EnrichmentStore.ts
 */

import type { RowDataPacket } from 'mysql2';
import type { MySQLAdapter } from '../db/MySQLAdapter';
import type { IEnrichmentStore } from './IEnrichmentStore';
import { hashRawTable } from './schemaHash';
import type { EnrichedTable, RawTable } from '../types';

const STORAGE_TABLE = 'nlsql_enriched_schema';

export class MySQLEnrichmentStore implements IEnrichmentStore {
  private readonly adapter: MySQLAdapter;

  constructor(adapter: MySQLAdapter) {
    this.adapter = adapter;
  }

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

  async load(tableName: string): Promise<EnrichedTable | null> {
    const rows = await this.adapter.rawQuery<RowDataPacket[]>(
      `SELECT \`enriched_json\` FROM \`${STORAGE_TABLE}\` WHERE \`table_name\` = ? LIMIT 1`,
      [tableName]
    );

    if (rows.length === 0) return null;

    try {
      return JSON.parse(rows[0]!['enriched_json'] as string) as EnrichedTable;
    } catch {
      return null;
    }
  }

  async loadAll(): Promise<EnrichedTable[]> {
    const rows = await this.adapter.rawQuery<RowDataPacket[]>(
      `SELECT \`enriched_json\` FROM \`${STORAGE_TABLE}\` ORDER BY \`table_name\``
    );

    const results: EnrichedTable[] = [];
    for (const row of rows) {
      try {
        results.push(JSON.parse(row['enriched_json'] as string) as EnrichedTable);
      } catch {
        // Skip corrupted rows
      }
    }
    return results;
  }

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

  async delete(tableName: string): Promise<void> {
    await this.adapter.rawQuery(
      `DELETE FROM \`${STORAGE_TABLE}\` WHERE \`table_name\` = ?`,
      [tableName]
    );
  }

  async clear(): Promise<void> {
    await this.adapter.rawQuery(`DELETE FROM \`${STORAGE_TABLE}\``);
  }

  isEnrichmentFresh(rawTable: RawTable, stored: EnrichedTable | null): boolean {
    if (stored === null) return false;
    const currentHash = hashRawTable(rawTable);
    return currentHash === stored.schemaHash;
  }

  static hashRawTable(rawTable: RawTable): string {
    return hashRawTable(rawTable);
  }
}

export class EnrichmentStore extends MySQLEnrichmentStore {}
