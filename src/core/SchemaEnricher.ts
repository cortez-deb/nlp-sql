/**
 * core/SchemaEnricher.ts
 *
 * SchemaEnricher orchestrates reading, sampling, filtering, and enriching schema data.
 */

import type { MySQLAdapter } from '../db/MySQLAdapter';
import type { BaseLLM } from '../llm/BaseLLM';
import type { IEnrichmentStore } from '../storage/IEnrichmentStore';
import { hashRawTable } from '../storage/schemaHash';
import type { EnrichedTable, EnrichmentOptions, RawTable, RawColumn } from '../types';

export interface EnrichmentProgress {
  tableName: string;
  completed: number;
  total: number;
  wasEnriched: boolean;
}

export interface EnrichmentSummary {
  totalTables: number;
  enriched: number;
  skipped: number;
  failed: string[];
  durationMs: number;
}

export interface SchemaConfig {
  excludeTables?: string[];
  excludeColumns?: string[];
}

const DEFAULT_PII_PATTERN = /(pass(word)?|passwd|secret|token|api[_-]?key|ssn|card[_-]?(no|number)|cvv|iban)/i;

function matchesGlob(text: string, pattern: string): boolean {
  const regexStr = '^' + pattern.toLowerCase().replace(/\./g, '\\.').replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr, 'i').test(text);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class SchemaEnricher {
  private readonly adapter: MySQLAdapter;
  private readonly llm: BaseLLM;
  private readonly store: IEnrichmentStore;
  private readonly schemaConfig?: SchemaConfig;

  constructor(
    adapter: MySQLAdapter,
    llm: BaseLLM,
    store: IEnrichmentStore,
    schemaConfig?: SchemaConfig
  ) {
    this.adapter = adapter;
    this.llm = llm;
    this.store = store;
    this.schemaConfig = schemaConfig;
  }

  async enrich(
    options: EnrichmentOptions = {},
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<EnrichmentSummary> {
    const startTime = Date.now();
    const sampleSize = options.sampleSize ?? 5;
    const forceRefresh = options.forceRefresh ?? false;

    // Step 1: Read raw schema from database
    const rawTables = await this.adapter.getSchema(options.tables);

    // Apply exclusions
    const filteredTables = this.filterSchema(rawTables);

    if (filteredTables.length === 0) {
      return {
        totalTables: 0,
        enriched: 0,
        skipped: 0,
        failed: [],
        durationMs: Date.now() - startTime,
      };
    }

    // Step 2: Load existing enrichments
    const tableNames = filteredTables.map((t) => t.tableName);
    const storedMap = await this.store.loadMany(tableNames);

    let enrichedCount = 0;
    let skippedCount = 0;
    const failedTables: string[] = [];

    for (let i = 0; i < filteredTables.length; i++) {
      const rawTable = filteredTables[i]!;
      const stored = storedMap.get(rawTable.tableName) ?? null;

      const schemaHash = hashRawTable(rawTable);
      const isFresh = !forceRefresh && this.store.isEnrichmentFresh(rawTable, stored);

      if (isFresh) {
        skippedCount++;
        onProgress?.({
          tableName: rawTable.tableName,
          completed: i + 1,
          total: filteredTables.length,
          wasEnriched: false,
        });
        continue;
      }

      const tableWithSamples = await this.addSamplesToTable(rawTable, sampleSize);

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
        total: filteredTables.length,
        wasEnriched: !failedTables.includes(rawTable.tableName),
      });
    }

    return {
      totalTables: filteredTables.length,
      enriched: enrichedCount,
      skipped: skippedCount,
      failed: failedTables,
      durationMs: Date.now() - startTime,
    };
  }

  async getEnrichedTables(): Promise<EnrichedTable[]> {
    return this.store.loadAll();
  }

  async findRelevantTables(
    userQuery: string,
    maxTables = 5
  ): Promise<EnrichedTable[]> {
    const allTables = await this.store.loadAll();

    if (allTables.length <= maxTables) {
      return allTables;
    }

    const queryWords = userQuery
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);

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
        const occurrences = (searchText.match(new RegExp(`\\b${escapeRegex(word)}\\b`, 'g')) ?? []).length;
        return total + occurrences;
      }, 0);

      return { table, score };
    });

    scored.sort((a, b) => b.score - a.score || a.table.tableName.localeCompare(b.table.tableName));

    const topTables = scored.slice(0, maxTables).map((s) => s.table);

    const selectedMap = new Map<string, EnrichedTable>();
    for (const t of topTables) {
      selectedMap.set(t.tableName.toLowerCase(), t);
    }

    const allTablesMap = new Map<string, EnrichedTable>();
    for (const t of allTables) {
      allTablesMap.set(t.tableName.toLowerCase(), t);
    }

    for (const t of topTables) {
      if (selectedMap.size >= maxTables + 2) break;
      if (t.foreignKeys) {
        for (const fk of t.foreignKeys) {
          const refTableLower = fk.referencedTable.toLowerCase();
          if (!selectedMap.has(refTableLower) && allTablesMap.has(refTableLower)) {
            selectedMap.set(refTableLower, allTablesMap.get(refTableLower)!);
            if (selectedMap.size >= maxTables + 2) break;
          }
        }
      }
    }

    return Array.from(selectedMap.values());
  }

  private filterSchema(rawTables: RawTable[]): RawTable[] {
    const excludeTableGlobs = this.schemaConfig?.excludeTables ?? [];
    const excludeColGlobs = this.schemaConfig?.excludeColumns ?? [];

    return rawTables
      .filter((table) => {
        return !excludeTableGlobs.some((pattern) => matchesGlob(table.tableName, pattern));
      })
      .map((table) => {
        const filteredCols = table.columns.filter((col) => {
          if (DEFAULT_PII_PATTERN.test(col.columnName)) {
            return false;
          }
          const qualifiedName = `${table.tableName}.${col.columnName}`;
          return !excludeColGlobs.some(
            (pattern) => matchesGlob(col.columnName, pattern) || matchesGlob(qualifiedName, pattern)
          );
        });
        return {
          ...table,
          columns: filteredCols,
        };
      });
  }

  private async addSamplesToTable(
    rawTable: RawTable,
    sampleSize: number
  ): Promise<RawTable> {
    if (sampleSize === 0) {
      return rawTable;
    }

    const columnsWithSamples: RawColumn[] = await Promise.all(
      rawTable.columns.map(async (col) => {
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
