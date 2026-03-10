/**
 * tests/unit/NLSQLClient.test.ts
 *
 * Unit tests for NLSQLClient — the main public class.
 *
 * All database and LLM calls are mocked. These tests verify:
 *  - That initialise() must be called before query()
 *  - That query() correctly wires together retrieval → generation → validation → execution
 *  - That failed validation is handled gracefully
 *  - That LLM/DB errors are wrapped in a safe QueryResult (never thrown)
 *  - That validateSQL() works as a standalone utility
 *  - That close() is safe to call
 */

import { NLSQLClient } from '../../src/core/NLSQLClient';
import type { NLSQLClientConfig } from '../../src/core/NLSQLClient';

// ── Config fixture ─────────────────────────────────────────────────────────────

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
    model: 'gemini-1.5-flash-latest',
  },
};

// ── Mock the internal dependencies ────────────────────────────────────────────
//
// We mock the module files so that when NLSQLClient's constructor
// imports MySQLAdapter, GeminiLLM etc., it gets our fake versions.

// Mock MySQLAdapter
jest.mock('../../src/db/MySQLAdapter', () => ({
  MySQLAdapter: {
    create: jest.fn(),
  },
}));

// Mock GeminiLLM
jest.mock('../../src/llm/GeminiLLM', () => ({
  GeminiLLM: jest.fn(),
}));

// Mock EnrichmentStore
jest.mock('../../src/storage/EnrichmentStore', () => ({
  EnrichmentStore: jest.fn(),
}));

// Mock SchemaEnricher
jest.mock('../../src/core/SchemaEnricher', () => ({
  SchemaEnricher: jest.fn(),
}));

import { MySQLAdapter } from '../../src/db/MySQLAdapter';
import { GeminiLLM } from '../../src/llm/GeminiLLM';
import { EnrichmentStore } from '../../src/storage/EnrichmentStore';
import { SchemaEnricher } from '../../src/core/SchemaEnricher';
import type { EnrichedTable } from '../../src/types';

// ── Helpers to build mock implementations ─────────────────────────────────────

function makeEnrichedTable(tableName = 'orders'): EnrichedTable {
  return {
    tableName,
    businessName: 'Customer Orders',
    description: 'Customer purchase records.',
    useCases: [],
    synonyms: [],
    columns: [],
    enrichedAt: '2024-01-01T00:00:00Z',
    schemaHash: 'hash123',
  };
}

function setupMocks({
  generateSQL = 'SELECT id FROM orders LIMIT 10',
  contextTables = [makeEnrichedTable()],
  executeResults = [{ id: 1 }, { id: 2 }],
  enrichSummary = { totalTables: 1, enriched: 1, skipped: 0, failed: [], durationMs: 100 },
}: {
  generateSQL?: string;
  contextTables?: EnrichedTable[];
  executeResults?: Record<string, unknown>[];
  enrichSummary?: object;
} = {}) {
  // Mock MySQLAdapter instance
  const mockAdapterInstance = {
    executeQuery: jest.fn().mockResolvedValue(executeResults),
    close: jest.fn().mockResolvedValue(undefined),
  };
  (MySQLAdapter.create as jest.Mock).mockResolvedValue(mockAdapterInstance);

  // Mock GeminiLLM instance
  const mockLLMInstance = {
    generateSQL: jest.fn().mockResolvedValue(generateSQL),
  };
  (GeminiLLM as unknown as jest.Mock).mockImplementation(() => mockLLMInstance);

  // Mock EnrichmentStore instance
  const mockStoreInstance = {
    initialise: jest.fn().mockResolvedValue(undefined),
  };
  (EnrichmentStore as unknown as jest.Mock).mockImplementation(() => mockStoreInstance);

  // Mock SchemaEnricher instance
  const mockEnricherInstance = {
    findRelevantTables: jest.fn().mockResolvedValue(contextTables),
    getEnrichedTables: jest.fn().mockResolvedValue(contextTables),
    enrich: jest.fn().mockResolvedValue(enrichSummary),
  };
  (SchemaEnricher as unknown as jest.Mock).mockImplementation(() => mockEnricherInstance);

  return { mockAdapterInstance, mockLLMInstance, mockStoreInstance, mockEnricherInstance };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NLSQLClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('initialise()', () => {
    it('connects to the database and sets up storage', async () => {
      const { mockAdapterInstance, mockStoreInstance } = setupMocks();
      const client = new NLSQLClient(testConfig);
      await client.initialise();

      expect(MySQLAdapter.create).toHaveBeenCalledWith(testConfig.db);
      expect(mockStoreInstance.initialise).toHaveBeenCalledTimes(1);
      expect(mockAdapterInstance.close).not.toHaveBeenCalled(); // not closed yet

      await client.close();
    });

    it('runs enrichment when enrichOptions are provided', async () => {
      const { mockEnricherInstance } = setupMocks();
      const client = new NLSQLClient(testConfig);

      const summary = await client.initialise({ forceRefresh: false });

      expect(mockEnricherInstance.enrich).toHaveBeenCalledTimes(1);
      expect(summary).not.toBeNull();
      expect(summary!.totalTables).toBe(1);

      await client.close();
    });

    it('skips enrichment when no enrichOptions are provided', async () => {
      const { mockEnricherInstance } = setupMocks();
      const client = new NLSQLClient(testConfig);

      const summary = await client.initialise(); // no options passed

      expect(mockEnricherInstance.enrich).not.toHaveBeenCalled();
      expect(summary).toBeNull();

      await client.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('query()', () => {
    it('throws if called before initialise()', async () => {
      const client = new NLSQLClient(testConfig);
      await expect(client.query('show orders')).rejects.toThrow('initialise()');
    });

    it('returns results for a valid natural language question', async () => {
      setupMocks({ generateSQL: 'SELECT id, name FROM orders LIMIT 10' });
      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.query('show me all orders');

      expect(result.error).toBeNull();
      expect(result.sql).toBe('SELECT id, name FROM orders LIMIT 10');
      expect(result.results).toHaveLength(2);
      expect(result.results![0]).toEqual({ id: 1 });

      await client.close();
    });

    it('returns error when LLM generates blocked SQL', async () => {
      setupMocks({ generateSQL: 'DELETE FROM orders WHERE 1=1' });
      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.query('delete all orders');

      expect(result.error).toContain('DELETE');
      expect(result.results).toBeNull();
      expect(result.sql).toBe('DELETE FROM orders WHERE 1=1');

      await client.close();
    });

    it('returns error when no enriched schema is available', async () => {
      setupMocks({ contextTables: [] }); // empty = no schema enriched yet
      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.query('show orders');

      expect(result.error).toContain('enrich()');
      expect(result.results).toBeNull();

      await client.close();
    });

    it('returns error when LLM throws', async () => {
      const { mockLLMInstance } = setupMocks();
      mockLLMInstance.generateSQL.mockRejectedValue(new Error('API rate limit exceeded'));

      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.query('show orders');

      expect(result.error).toContain('API rate limit exceeded');
      expect(result.results).toBeNull();

      await client.close();
    });

    it('returns error when database execution fails', async () => {
      const { mockAdapterInstance } = setupMocks();
      mockAdapterInstance.executeQuery.mockRejectedValue(new Error('Table does not exist'));

      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.query('show orders');

      expect(result.error).toContain('Table does not exist');
      expect(result.results).toBeNull();
      // SQL was generated and validated — it's still returned
      expect(result.sql).not.toBeNull();

      await client.close();
    });

    it('handles LLM UNABLE_TO_ANSWER response gracefully', async () => {
      setupMocks({
        generateSQL: '-- UNABLE_TO_ANSWER: The schema does not contain revenue data',
      });
      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.query('what was our profit last year?');

      expect(result.results).toBeNull();
      expect(result.error).toContain('could not generate a query');

      await client.close();
    });

    it('includes timing information in all results', async () => {
      setupMocks();
      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.query('show orders');

      expect(result.timing).toBeDefined();
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
      expect(result.timing.retrievalMs).toBeGreaterThanOrEqual(0);
      expect(result.timing.generationMs).toBeGreaterThanOrEqual(0);
      expect(result.timing.validationMs).toBeGreaterThanOrEqual(0);
      expect(result.timing.executionMs).toBeGreaterThanOrEqual(0);

      await client.close();
    });

    it('passes maxRows option through to the adapter', async () => {
      const { mockAdapterInstance } = setupMocks();
      const client = new NLSQLClient(testConfig);
      await client.initialise();

      await client.query('show orders', { maxRows: 50 });

      expect(mockAdapterInstance.executeQuery).toHaveBeenCalledWith(
        expect.any(String),
        50
      );

      await client.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('validateSQL()', () => {
    it('validates SQL without requiring initialise()', () => {
      const client = new NLSQLClient(testConfig);
      const result = client.validateSQL('SELECT id FROM users');
      expect(result.isValid).toBe(true);
    });

    it('rejects dangerous SQL', () => {
      const client = new NLSQLClient(testConfig);
      const result = client.validateSQL('DROP TABLE users');
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('DROP');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('getEnrichedSchema()', () => {
    it('throws if called before initialise()', async () => {
      const client = new NLSQLClient(testConfig);
      await expect(client.getEnrichedSchema()).rejects.toThrow('initialise()');
    });

    it('returns enriched tables after initialisation', async () => {
      const tables = [makeEnrichedTable('orders'), makeEnrichedTable('customers')];
      setupMocks({ contextTables: tables });

      const client = new NLSQLClient(testConfig);
      await client.initialise();

      const result = await client.getEnrichedSchema();
      expect(result).toHaveLength(2);

      await client.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('close()', () => {
    it('closes the database connection', async () => {
      const { mockAdapterInstance } = setupMocks();
      const client = new NLSQLClient(testConfig);
      await client.initialise();
      await client.close();

      expect(mockAdapterInstance.close).toHaveBeenCalledTimes(1);
    });

    it('is safe to call before initialise() (no-op)', async () => {
      const client = new NLSQLClient(testConfig);
      await expect(client.close()).resolves.not.toThrow();
    });
  });
});
