/**
 * storage/FileEnrichmentStore.ts
 */

import fs from 'fs';
import path from 'path';
import type { IEnrichmentStore } from './IEnrichmentStore';
import { hashRawTable } from './schemaHash';
import type { EnrichedTable, RawTable } from '../types';

interface FileStoreData {
  version: number;
  tables: Record<string, EnrichedTable>;
}

export class FileEnrichmentStore implements IEnrichmentStore {
  private readonly filePath: string;

  constructor(filePath = './.nlsql/enrichment.json') {
    this.filePath = path.resolve(filePath);
  }

  async initialise(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
  }

  private async readFileData(): Promise<FileStoreData> {
    try {
      const content = await fs.promises.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.tables) {
        return parsed as FileStoreData;
      }
    } catch {
      // Missing or corrupt file -> return empty
    }
    return { version: 2, tables: {} };
  }

  private async writeFileData(data: FileStoreData): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });

    const tmpPath = `${this.filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.promises.rename(tmpPath, this.filePath);
  }

  async save(enriched: EnrichedTable): Promise<void> {
    const data = await this.readFileData();
    data.tables[enriched.tableName] = enriched;
    await this.writeFileData(data);
  }

  async load(tableName: string): Promise<EnrichedTable | null> {
    const data = await this.readFileData();
    return data.tables[tableName] ?? null;
  }

  async loadAll(): Promise<EnrichedTable[]> {
    const data = await this.readFileData();
    return Object.values(data.tables);
  }

  async loadMany(tableNames: string[]): Promise<Map<string, EnrichedTable>> {
    const data = await this.readFileData();
    const result = new Map<string, EnrichedTable>();
    for (const name of tableNames) {
      if (data.tables[name]) {
        result.set(name, data.tables[name]);
      }
    }
    return result;
  }

  async delete(tableName: string): Promise<void> {
    const data = await this.readFileData();
    delete data.tables[tableName];
    await this.writeFileData(data);
  }

  async clear(): Promise<void> {
    await this.writeFileData({ version: 2, tables: {} });
  }

  isEnrichmentFresh(rawTable: RawTable, stored: EnrichedTable | null): boolean {
    if (stored === null) return false;
    const currentHash = hashRawTable(rawTable);
    return currentHash === stored.schemaHash;
  }
}
