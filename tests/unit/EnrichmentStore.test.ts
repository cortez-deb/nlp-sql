/**
 * tests/unit/EnrichmentStore.test.ts
 *
 * Unit tests for EnrichmentStore.
 *
 * These tests use a mock MySQLAdapter so no real database is needed.
 * They verify:
 *  - The storage table is created on initialise()
 *  - save(), load(), loadAll(), loadMany(), delete(), clear() all work
 *  - Change detection (isEnrichmentFresh) correctly identifies stale data
 *  - hashRawTable produces consistent, deterministic hashes
 */

import { EnrichmentStore } from '../../src/storage/EnrichmentStore';
import type { EnrichedTable, RawTable } from '../../src/types';

// ── Mock MySQLAdapter ─────────────────────────────────────────────────────────
//
// Instead of opening a real MySQL connection, we create a "mock" adapter
// that stores data in a JavaScript Map (in memory). This lets us test
// EnrichmentStore's logic without needing a database.

function makeMockAdapter() {
  // Simulates the nlsql_enriched_schema table as an in-memory map
  const storage = new Map<string, { enriched_json: string; schema_hash: string }>();

  return {
    storage, // expose for assertions
    rawQuery: jest.fn(async (sql: string, params: unknown[] = []) => {
      const s = sql.trim().toUpperCase();

      if (s.startsWith('CREATE TABLE')) {
        return [];
      }

      if (s.startsWith('INSERT INTO')) {
        // save() — upsert
        const tableName = params[0] as string;
        const json = params[1] as string;
        const hash = params[2] as string;
        storage.set(tableName, { enriched_json: json, schema_hash: hash });
        return [];
      }

      if (s.startsWith('SELECT') && s.includes('WHERE') && params.length === 1) {
        // load() — single table
        const tableName = params[0] as string;
        const row = storage.get(tableName);
        return row ? [{ enriched_json: row.enriched_json }] : [];
      }

      if (s.startsWith('SELECT') && s.includes('IN (')) {
        // loadMany() — multiple tables
        const tableNames = params as string[];
        return tableNames
          .filter((n) => storage.has(n))
          .map((n) => ({
            table_name: n,
            enriched_json: storage.get(n)!.enriched_json,
          }));
      }

      if (s.startsWith('SELECT') && !s.includes('WHERE')) {
        // loadAll()
        return [...storage.entries()].map(([name, val]) => ({
          table_name: name,
          enriched_json: val.enriched_json,
        }));
      }

      if (s.startsWith('DELETE') && s.includes('WHERE')) {
        // delete()
        const tableName = params[0] as string;
        storage.delete(tableName);
        return [];
      }

      if (s.startsWith('DELETE') && !s.includes('WHERE')) {
        // clear()
        storage.clear();
        return [];
      }

      return [];
    }),
  };
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeEnrichedTable(tableName = 'orders'): EnrichedTable {
  return {
    tableName,
    businessName: 'Customer Orders',
    description: 'Records every purchase a customer has placed.',
    useCases: ['How many orders were placed last month?'],
    synonyms: ['purchases', 'transactions'],
    columns: [
      {
        name: 'id',
        businessLabel: 'Order ID',
        description: 'Unique identifier for each order.',
        synonyms: [],
        exampleQuestions: ['Show me order 123'],
      },
      {
        name: 'total_amount',
        businessLabel: 'Order Total',
        description: 'Total monetary value of the order.',
        synonyms: ['total', 'amount', 'price'],
        exampleQuestions: ['What is the average order total?'],
      },
    ],
    enrichedAt: '2024-01-15T10:00:00.000Z',
    schemaHash: 'abc123',
  };
}

function makeRawTable(tableName = 'orders'): RawTable {
  return {
    tableName,
    tableComment: '',
    tableRows: 5000,
    columns: [
      {
        columnName: 'id',
        dataType: 'int',
        isNullable: 'NO',
        ordinalPosition: 1,
        columnDefault: null,
        extra: 'auto_increment',
        columnKey: 'PRI',
        columnComment: '',
      },
      {
        columnName: 'total_amount',
        dataType: 'decimal',
        isNullable: 'NO',
        ordinalPosition: 2,
        columnDefault: null,
        extra: '',
        columnKey: '',
        columnComment: '',
      },
    ],
    foreignKeys: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EnrichmentStore', () => {
  let mockAdapter: ReturnType<typeof makeMockAdapter>;
  let store: EnrichmentStore;

  beforeEach(() => {
    mockAdapter = makeMockAdapter();
    store = new EnrichmentStore(mockAdapter as never);
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('initialise()', () => {
    it('calls rawQuery with CREATE TABLE IF NOT EXISTS', async () => {
      await store.initialise();
      expect(mockAdapter.rawQuery).toHaveBeenCalledTimes(1);
      const sql = (mockAdapter.rawQuery.mock.calls[0]![0] as string).toUpperCase();
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS');
      expect(sql).toContain('NLSQL_ENRICHED_SCHEMA');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('save() and load()', () => {
    it('saves an enriched table and retrieves it by name', async () => {
      const enriched = makeEnrichedTable('orders');
      await store.save(enriched);

      const loaded = await store.load('orders');
      expect(loaded).not.toBeNull();
      expect(loaded!.tableName).toBe('orders');
      expect(loaded!.businessName).toBe('Customer Orders');
    });

    it('returns null for a table that has not been saved', async () => {
      const loaded = await store.load('nonexistent_table');
      expect(loaded).toBeNull();
    });

    it('overwrites an existing enrichment with a new save', async () => {
      const original = makeEnrichedTable('orders');
      await store.save(original);

      const updated = { ...original, businessName: 'Updated Orders Name' };
      await store.save(updated);

      const loaded = await store.load('orders');
      expect(loaded!.businessName).toBe('Updated Orders Name');
    });

    it('saves and loads all column data intact', async () => {
      const enriched = makeEnrichedTable();
      await store.save(enriched);

      const loaded = await store.load('orders');
      expect(loaded!.columns).toHaveLength(2);
      expect(loaded!.columns[0]!.name).toBe('id');
      expect(loaded!.columns[1]!.synonyms).toContain('total');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('loadAll()', () => {
    it('returns empty array when nothing is stored', async () => {
      const results = await store.loadAll();
      expect(results).toEqual([]);
    });

    it('returns all stored enrichments', async () => {
      await store.save(makeEnrichedTable('orders'));
      await store.save(makeEnrichedTable('customers'));
      await store.save(makeEnrichedTable('products'));

      const results = await store.loadAll();
      expect(results).toHaveLength(3);

      const names = results.map((r) => r.tableName).sort();
      expect(names).toEqual(['customers', 'orders', 'products']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('loadMany()', () => {
    it('returns empty Map for empty input', async () => {
      const result = await store.loadMany([]);
      expect(result.size).toBe(0);
    });

    it('returns only tables that exist in storage', async () => {
      await store.save(makeEnrichedTable('orders'));
      await store.save(makeEnrichedTable('customers'));

      const map = await store.loadMany(['orders', 'customers', 'nonexistent']);
      expect(map.size).toBe(2);
      expect(map.has('orders')).toBe(true);
      expect(map.has('customers')).toBe(true);
      expect(map.has('nonexistent')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('delete()', () => {
    it('removes a specific table enrichment', async () => {
      await store.save(makeEnrichedTable('orders'));
      await store.save(makeEnrichedTable('customers'));

      await store.delete('orders');

      expect(await store.load('orders')).toBeNull();
      expect(await store.load('customers')).not.toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('clear()', () => {
    it('removes all stored enrichments', async () => {
      await store.save(makeEnrichedTable('orders'));
      await store.save(makeEnrichedTable('customers'));

      await store.clear();

      const all = await store.loadAll();
      expect(all).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('isEnrichmentFresh()', () => {
    it('returns false when stored enrichment is null', () => {
      const raw = makeRawTable();
      expect(store.isEnrichmentFresh(raw, null)).toBe(false);
    });

    it('returns true when schema has not changed', () => {
      const raw = makeRawTable();
      const hash = EnrichmentStore.hashRawTable(raw);
      const stored = makeEnrichedTable();
      stored.schemaHash = hash;

      expect(store.isEnrichmentFresh(raw, stored)).toBe(true);
    });

    it('returns false when schema has changed', () => {
      const raw = makeRawTable();
      const stored = makeEnrichedTable();
      stored.schemaHash = 'old_hash_that_no_longer_matches';

      expect(store.isEnrichmentFresh(raw, stored)).toBe(false);
    });

    it('detects a new column as a schema change', () => {
      const raw = makeRawTable();
      const hashBefore = EnrichmentStore.hashRawTable(raw);

      // Add a new column
      const rawModified = {
        ...raw,
        columns: [
          ...raw.columns,
          {
            columnName: 'status',
            dataType: 'varchar',
            isNullable: 'YES',
            ordinalPosition: 3,
            columnDefault: null,
            extra: '',
            columnKey: '',
            columnComment: '',
          },
        ],
      };
      const hashAfter = EnrichmentStore.hashRawTable(rawModified);

      expect(hashBefore).not.toBe(hashAfter);
    });

    it('detects a changed column type as a schema change', () => {
      const raw = makeRawTable();
      const hashBefore = EnrichmentStore.hashRawTable(raw);

      const rawModified = {
        ...raw,
        columns: [
          raw.columns[0]!,
          { ...raw.columns[1]!, dataType: 'bigint' }, // changed from decimal
        ],
      };
      const hashAfter = EnrichmentStore.hashRawTable(rawModified);

      expect(hashBefore).not.toBe(hashAfter);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('hashRawTable()', () => {
    it('produces a 64-character hex string', () => {
      const hash = EnrichmentStore.hashRawTable(makeRawTable());
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it('produces the same hash for identical schemas', () => {
      const raw1 = makeRawTable();
      const raw2 = makeRawTable();
      expect(EnrichmentStore.hashRawTable(raw1)).toBe(EnrichmentStore.hashRawTable(raw2));
    });

    it('produces different hashes for different tables', () => {
      const raw1 = makeRawTable('orders');
      const raw2 = makeRawTable('customers');
      expect(EnrichmentStore.hashRawTable(raw1)).not.toBe(EnrichmentStore.hashRawTable(raw2));
    });

    it('is stable regardless of column order in the input', () => {
      const raw = makeRawTable();
      const rawReversedColumns = {
        ...raw,
        columns: [...raw.columns].reverse(),
      };
      // Columns should be sorted by ordinalPosition, so order shouldn't matter
      expect(EnrichmentStore.hashRawTable(raw)).toBe(
        EnrichmentStore.hashRawTable(rawReversedColumns)
      );
    });
  });
});
