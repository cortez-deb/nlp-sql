/**
 * tests/unit/FileEnrichmentStore.test.ts
 */

import fs from 'fs';
import path from 'path';
import { FileEnrichmentStore } from '../../src/storage/FileEnrichmentStore';
import type { EnrichedTable } from '../../src/types';

const TEST_DIR = path.resolve('./.test_nlsql');
const TEST_FILE = path.join(TEST_DIR, 'enrichment.json');

function makeEnrichedTable(tableName = 'orders'): EnrichedTable {
  return {
    tableName,
    businessName: 'Customer Orders',
    description: 'Records purchases.',
    useCases: [],
    synonyms: [],
    columns: [],
    foreignKeys: [],
    primaryKey: ['id'],
    rowCountApprox: 10,
    enrichedAt: '2024-01-01T00:00:00Z',
    schemaHash: 'hash1',
  };
}

describe('FileEnrichmentStore', () => {
  beforeEach(async () => {
    await fs.promises.rm(TEST_DIR, { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.promises.rm(TEST_DIR, { recursive: true, force: true });
  });

  it('performs round-trip save and load', async () => {
    const store = new FileEnrichmentStore(TEST_FILE);
    await store.initialise();

    const table = makeEnrichedTable('orders');
    await store.save(table);

    const loaded = await store.load('orders');
    expect(loaded).not.toBeNull();
    expect(loaded?.tableName).toBe('orders');
    expect(loaded?.businessName).toBe('Customer Orders');
  });

  it('handles missing or corrupt file gracefully', async () => {
    const store = new FileEnrichmentStore(TEST_FILE);
    await store.initialise();

    // Corrupt the file
    await fs.promises.writeFile(TEST_FILE, 'corrupted json data {');

    const loaded = await store.load('orders');
    expect(loaded).toBeNull();

    const all = await store.loadAll();
    expect(all).toEqual([]);
  });

  it('atomic write leaves no temporary files behind', async () => {
    const store = new FileEnrichmentStore(TEST_FILE);
    await store.initialise();

    await store.save(makeEnrichedTable('t1'));

    const files = await fs.promises.readdir(TEST_DIR);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('enrichment.json');
  });
});
