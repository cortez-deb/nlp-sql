/**
 * tests/unit/SchemaEnricher.test.ts
 *
 * Unit tests for SchemaEnricher.
 *
 * All three dependencies (MySQLAdapter, BaseLLM, EnrichmentStore) are mocked
 * using Jest's mock functions. This lets us test the orchestration logic —
 * "does SchemaEnricher call the right things in the right order?" —
 * without touching a database or calling an LLM API.
 */

import { SchemaEnricher } from '../../src/core/SchemaEnricher';
import { EnrichmentStore } from '../../src/storage/EnrichmentStore';
import type { RawTable, EnrichedTable } from '../../src/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRawTable(tableName: string): RawTable {
  return {
    tableName,
    tableComment: '',
    tableRows: 100,
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
        columnName: 'name',
        dataType: 'varchar',
        isNullable: 'YES',
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

function makeEnrichedTable(tableName: string, schemaHash: string): EnrichedTable {
  return {
    tableName,
    businessName: `${tableName} business name`,
    description: `Description of ${tableName}`,
    useCases: ['Use case 1'],
    synonyms: ['alias1'],
    columns: [],
    enrichedAt: '2024-01-01T00:00:00Z',
    schemaHash,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SchemaEnricher', () => {
  // We'll create fresh mocks for each test to avoid cross-test contamination
  let mockAdapter: jest.Mocked<{
    getSchema: (tables?: string[]) => Promise<RawTable[]>;
    sampleColumn: (table: string, column: string, limit: number) => Promise<string>;
  }>;

  let mockLLM: jest.Mocked<{
    enrichTable: (raw: RawTable, hash: string) => Promise<EnrichedTable>;
    generateSQL: () => Promise<string>;
  }>;

  let mockStore: jest.Mocked<{
    loadMany: (names: string[]) => Promise<Map<string, EnrichedTable>>;
    save: (t: EnrichedTable) => Promise<void>;
    loadAll: () => Promise<EnrichedTable[]>;
    isEnrichmentFresh: (raw: RawTable, stored: EnrichedTable | null) => boolean;
  }>;

  let enricher: SchemaEnricher;

  beforeEach(() => {
    mockAdapter = {
      getSchema: jest.fn(),
      sampleColumn: jest.fn().mockResolvedValue('sample1, sample2'),
    };

    mockLLM = {
      enrichTable: jest.fn(),
      generateSQL: jest.fn(),
    };

    mockStore = {
      loadMany: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
      loadAll: jest.fn(),
      isEnrichmentFresh: jest.fn(),
    };

    enricher = new SchemaEnricher(
      mockAdapter as never,
      mockLLM as never,
      mockStore as never
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('enrich()', () => {
    it('returns zero counts when no tables exist', async () => {
      mockAdapter.getSchema.mockResolvedValue([]);
      mockStore.loadMany.mockResolvedValue(new Map());

      const summary = await enricher.enrich();

      expect(summary.totalTables).toBe(0);
      expect(summary.enriched).toBe(0);
      expect(summary.skipped).toBe(0);
      expect(summary.failed).toHaveLength(0);
    });

    it('enriches tables that have no stored enrichment', async () => {
      const rawTable = makeRawTable('orders');
      const schemaHash = EnrichmentStore.hashRawTable(rawTable);
      const enriched = makeEnrichedTable('orders', schemaHash);

      mockAdapter.getSchema.mockResolvedValue([rawTable]);
      mockStore.loadMany.mockResolvedValue(new Map()); // no stored enrichment
      mockStore.isEnrichmentFresh.mockReturnValue(false);
      mockLLM.enrichTable.mockResolvedValue(enriched);

      const summary = await enricher.enrich();

      expect(mockLLM.enrichTable).toHaveBeenCalledTimes(1);
      expect(mockStore.save).toHaveBeenCalledWith(enriched);
      expect(summary.enriched).toBe(1);
      expect(summary.skipped).toBe(0);
    });

    it('skips tables whose enrichment is fresh', async () => {
      const rawTable = makeRawTable('orders');
      const schemaHash = EnrichmentStore.hashRawTable(rawTable);
      const storedEnriched = makeEnrichedTable('orders', schemaHash);

      mockAdapter.getSchema.mockResolvedValue([rawTable]);
      mockStore.loadMany.mockResolvedValue(new Map([['orders', storedEnriched]]));
      mockStore.isEnrichmentFresh.mockReturnValue(true); // fresh!

      const summary = await enricher.enrich();

      expect(mockLLM.enrichTable).not.toHaveBeenCalled();
      expect(summary.enriched).toBe(0);
      expect(summary.skipped).toBe(1);
    });

    it('force-refreshes all tables when forceRefresh is true', async () => {
      const rawTable = makeRawTable('orders');
      const schemaHash = EnrichmentStore.hashRawTable(rawTable);
      const enriched = makeEnrichedTable('orders', schemaHash);

      mockAdapter.getSchema.mockResolvedValue([rawTable]);
      mockStore.loadMany.mockResolvedValue(new Map());
      // Even if isEnrichmentFresh returned true, forceRefresh bypasses it
      mockStore.isEnrichmentFresh.mockReturnValue(true);
      mockLLM.enrichTable.mockResolvedValue(enriched);

      const summary = await enricher.enrich({ forceRefresh: true });

      // With forceRefresh, isEnrichmentFresh is bypassed, LLM should be called
      expect(mockLLM.enrichTable).toHaveBeenCalledTimes(1);
      expect(summary.enriched).toBe(1);
    });

    it('records failed tables without crashing', async () => {
      const rawTable = makeRawTable('broken_table');

      mockAdapter.getSchema.mockResolvedValue([rawTable]);
      mockStore.loadMany.mockResolvedValue(new Map());
      mockStore.isEnrichmentFresh.mockReturnValue(false);
      mockLLM.enrichTable.mockRejectedValue(new Error('LLM API timeout'));

      const summary = await enricher.enrich();

      expect(summary.failed).toContain('broken_table');
      expect(summary.enriched).toBe(0);
    });

    it('calls onProgress callback for each table', async () => {
      const rawTables = [makeRawTable('t1'), makeRawTable('t2'), makeRawTable('t3')];
      const progressCalls: string[] = [];

      mockAdapter.getSchema.mockResolvedValue(rawTables);
      mockStore.loadMany.mockResolvedValue(new Map());
      mockStore.isEnrichmentFresh.mockReturnValue(false);
      mockLLM.enrichTable.mockImplementation(async (raw) =>
        makeEnrichedTable(raw.tableName, EnrichmentStore.hashRawTable(raw))
      );

      await enricher.enrich({}, (progress) => {
        progressCalls.push(progress.tableName);
      });

      expect(progressCalls).toEqual(['t1', 't2', 't3']);
    });

    it('passes timing duration in summary', async () => {
      mockAdapter.getSchema.mockResolvedValue([]);
      mockStore.loadMany.mockResolvedValue(new Map());

      const summary = await enricher.enrich();
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('passes specific table names to getSchema when provided', async () => {
      mockAdapter.getSchema.mockResolvedValue([]);
      mockStore.loadMany.mockResolvedValue(new Map());

      await enricher.enrich({ tables: ['orders', 'customers'] });

      expect(mockAdapter.getSchema).toHaveBeenCalledWith(['orders', 'customers']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('findRelevantTables()', () => {
    const tables: EnrichedTable[] = [
      {
        tableName: 'orders',
        businessName: 'Customer Orders',
        description: 'All purchases made by customers.',
        useCases: ['How many orders last month?'],
        synonyms: ['purchases', 'transactions'],
        columns: [
          {
            name: 'status',
            businessLabel: 'Order Status',
            description: 'Whether the order is pending or delivered.',
            synonyms: ['delivery status'],
            exampleQuestions: ['Show pending orders'],
          },
        ],
        enrichedAt: '',
        schemaHash: '',
      },
      {
        tableName: 'customers',
        businessName: 'Customers',
        description: 'Registered users who have made purchases.',
        useCases: ['How many customers signed up?'],
        synonyms: ['users', 'clients'],
        columns: [
          {
            name: 'email',
            businessLabel: 'Email Address',
            description: "The customer's email.",
            synonyms: ['email address'],
            exampleQuestions: ['Find customer by email'],
          },
        ],
        enrichedAt: '',
        schemaHash: '',
      },
      {
        tableName: 'products',
        businessName: 'Product Catalogue',
        description: 'Items available for sale.',
        useCases: ['What products do we sell?'],
        synonyms: ['items', 'inventory'],
        columns: [],
        enrichedAt: '',
        schemaHash: '',
      },
    ];

    beforeEach(() => {
      mockStore.loadAll.mockResolvedValue(tables);
    });

    it('returns all tables when count is under the limit', async () => {
      const result = await enricher.findRelevantTables('any question', 10);
      expect(result).toHaveLength(3);
    });

    it('returns top tables by relevance when over the limit', async () => {
      // Query about orders — "orders" table should score highest
      const result = await enricher.findRelevantTables('show me pending orders', 1);
      expect(result).toHaveLength(1);
      expect(result[0]!.tableName).toBe('orders');
    });

    it('scores by synonym matching', async () => {
      // "purchases" is a synonym for orders
      const result = await enricher.findRelevantTables('list all purchases', 1);
      expect(result[0]!.tableName).toBe('orders');
    });

    it('scores by column metadata', async () => {
      // "email" and "customers" should surface the customers table
      const result = await enricher.findRelevantTables('find customer by email address', 1);
      expect(result[0]!.tableName).toBe('customers');
    });

    it('returns empty array when no enriched tables exist', async () => {
      mockStore.loadAll.mockResolvedValue([]);
      const result = await enricher.findRelevantTables('anything');
      expect(result).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('getEnrichedTables()', () => {
    it('delegates to store.loadAll()', async () => {
      const stored = [makeEnrichedTable('orders', 'h1')];
      mockStore.loadAll.mockResolvedValue(stored);

      const result = await enricher.getEnrichedTables();
      expect(result).toEqual(stored);
      expect(mockStore.loadAll).toHaveBeenCalledTimes(1);
    });
  });
});
