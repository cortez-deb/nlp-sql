/**
 * storage/IEnrichmentStore.ts
 */

import type { EnrichedTable, RawTable } from '../types';

export interface IEnrichmentStore {
  initialise(): Promise<void>;
  save(enriched: EnrichedTable): Promise<void>;
  load(tableName: string): Promise<EnrichedTable | null>;
  loadAll(): Promise<EnrichedTable[]>;
  loadMany(tableNames: string[]): Promise<Map<string, EnrichedTable>>;
  delete(tableName: string): Promise<void>;
  clear(): Promise<void>;
  isEnrichmentFresh(rawTable: RawTable, stored: EnrichedTable | null): boolean;
}
