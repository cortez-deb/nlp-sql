/**
 * tests/unit/NLSQLClient.test.ts
 */

import { NLSQLClient } from '../../src/core/NLSQLClient';
import type { NLSQLClientConfig } from '../../src/core/NLSQLClient';

const testConfig: NLSQLClientConfig = {
  db: {
    host: 'localhost',
    user: 'test_user',
    password: 'test_password',
    database: 'test_db',
  },
  llm: {
    provider: 'gemini',
    apiKey: 'test-gemini-key',
    model: 'gemini-2.0-flash',
  },
};

jest.mock('../../src/db/MySQLAdapter', () => ({
  MySQLAdapter: {
    create: jest.fn(),
  },
}));

jest.mock('../../src/llm/GeminiLLM', () => ({
  GeminiLLM: jest.fn(),
}));

jest.mock('../../src/storage/EnrichmentStore', () => ({
  EnrichmentStore: jest.fn(),
  MySQLEnrichmentStore: jest.fn(),
}));

jest.mock('../../src/storage/FileEnrichmentStore', () => ({
  FileEnrichmentStore: jest.fn(),
}));

jest.mock('../../src/core/SchemaEnricher', () => ({
  SchemaEnricher: jest.fn(),
}));

import { MySQLAdapter } from '../../src/db/MySQLAdapter';
import { GeminiLLM } from '../../src/llm/GeminiLLM';
import { FileEnrichmentStore } from '../../src/storage/FileEnrichmentStore';
import { SchemaEnricher } from '../../src/core/SchemaEnricher';
import type { EnrichedTable } from '../../src/types';

function makeEnrichedTable(tableName = 'orders'): EnrichedTable {
  return {
    tableName,
    businessName: 'Customer Orders',
    description: 'Customer purchase records.',
    useCases: [],
    synonyms: [],
    columns: [],
    foreignKeys: [],
    primaryKey: ['id'],
    rowCountApprox: 100,
    enrichedAt: '2024-01-01T00:00:00Z',
    schemaHash: 'hash123',
  };
}

function setupMocks({
  generateSQL = 'SELECT orders.id FROM orders LIMIT 10',
  contextTables = [makeEnrichedTable()],
  executeResults = [{ id: 1 }, { id: 2 }],
  truncated = false,
  enrichSummary = { totalTables: 1, enriched: 1, skipped: 0, failed: [], durationMs: 100 },
}: {
  generateSQL?: string | ((input: any) => Promise<string>);
  contextTables?: EnrichedTable[];
  executeResults?: Record<string, unknown>[];
  truncated?: boolean;
  enrichSummary?: object;
} = {}) {
  const mockAdapterInstance = {
    executeQuery: jest.fn().mockResolvedValue({ rows: executeResults, truncated }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  (MySQLAdapter.create as jest.Mock).mockResolvedValue(mockAdapterInstance);

  const mockLLMInstance = {
    generateSQL: typeof generateSQL === 'function' ? jest.fn().mockImplementation(generateSQL) : jest.fn().mockResolvedValue(generateSQL),
    summarizeResult: jest.fn().mockResolvedValue('Summary of results'),
  };
  (GeminiLLM as unknown as jest.Mock).mockImplementation(() => mockLLMInstance);

  const mockStoreInstance = {
    initialise: jest.fn().mockResolvedValue(undefined),
    loadAll: jest.fn().mockResolvedValue(contextTables),
  };
  (FileEnrichmentStore as unknown as jest.Mock).mockImplementation(() => mockStoreInstance);

  const mockEnricherInstance = {
    findRelevantTables: jest.fn().mockResolvedValue(contextTables),
    getEnrichedTables: jest.fn().mockResolvedValue(contextTables),
    enrich: jest.fn().mockResolvedValue(enrichSummary),
  };
  (SchemaEnricher as unknown as jest.Mock).mockImplementation(() => mockEnricherInstance);

  return { mockAdapterInstance, mockLLMInstance, mockStoreInstance, mockEnricherInstance };
}

describe('NLSQLClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initialise()', () => {
    it('connects to database and sets up file storage by default', async () => {
      const { mockStoreInstance } = setupMocks();
      const client = new NLSQLClient(testConfig);
      await client.initialise();

      expect(MySQLAdapter.create).toHaveBeenCalledWith(testConfig.db);
      expect(mockStoreInstance.initialise).toHaveBeenCalledTimes(1);

      await client.close();
    });
  });

  describe('query() and retry loop', () => {
    it('throws if called before initialise()', async () => {
      const client = new NLSQLClient(testConfig);
      await expect(client.query('show orders')).rejects.toThrow('initialise()');
    });

    it('returns results for a valid natural language question', async () => {
      setupMocks({ generateSQL: 'SELECT orders.id FROM orders LIMIT 10' });
      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.query('show me all orders');

      expect(result.error).toBeNull();
      expect(result.sql).toBe('SELECT orders.id FROM orders LIMIT 10');
      expect(result.results).toHaveLength(2);
      expect(result.attempts).toBe(1);

      await client.close();
    });

    it('retries when validation fails and succeeds on 2nd attempt', async () => {
      let callCount = 0;
      setupMocks({
        generateSQL: async (_input) => {
          callCount++;
          if (callCount === 1) {
            return 'SELECT * FROM unknown_table';
          }
          return 'SELECT orders.id FROM orders LIMIT 10';
        },
      });

      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.query('show orders');
      expect(result.error).toBeNull();
      expect(result.attempts).toBe(2);

      await client.close();
    });

    it('never retries on -- UNABLE_TO_ANSWER sentinel', async () => {
      const { mockLLMInstance } = setupMocks({
        generateSQL: '-- UNABLE_TO_ANSWER: no such data',
      });

      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.query('what is x?');
      expect(result.error).toContain('no such data');
      expect(result.attempts).toBe(1);
      expect(mockLLMInstance.generateSQL).toHaveBeenCalledTimes(1);

      await client.close();
    });

    it('stops at maxRetries + 1 when validation constantly fails', async () => {
      setupMocks({ generateSQL: 'SELECT * FROM unallowed_table' });
      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.query('show orders', { maxRetries: 2 });
      expect(result.attempts).toBe(3);
      expect(result.error).toContain('not in the allowed tables list');

      await client.close();
    });
  });

  describe('summarize logic', () => {
    it('returns fixed summary when 0 rows returned without calling LLM', async () => {
      const { mockLLMInstance } = setupMocks({ executeResults: [] });
      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.query('show orders', { summarize: true });
      expect(result.summary).toBe('No matching records found.');
      expect(mockLLMInstance.summarizeResult).not.toHaveBeenCalled();

      await client.close();
    });

    it('calls LLM for summary when rows are returned and summarize is true', async () => {
      const { mockLLMInstance } = setupMocks({ executeResults: [{ id: 1 }] });
      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.query('show orders', { summarize: true });
      expect(result.summary).toBe('Summary of results');
      expect(mockLLMInstance.summarizeResult).toHaveBeenCalledTimes(1);

      await client.close();
    });
  });

  describe('validateSQL()', () => {
    it('validates SQL without requiring initialise()', () => {
      const client = new NLSQLClient(testConfig);
      const result = client.validateSQL('SELECT orders.id FROM orders');
      expect(result.isValid).toBe(true);
    });
  });
});
