/**
 * tests/unit/OpenAILLM.test.ts
 *
 * Unit tests for the OpenAILLM class.
 *
 * All HTTP calls to the OpenAI API are mocked using Jest's global fetch mock.
 * No real API calls are made — these tests run entirely offline.
 *
 * Tests cover:
 *  - Successful SQL generation
 *  - Successful table enrichment (JSON parsing)
 *  - API error handling (non-200 responses)
 *  - Network error handling (fetch throws)
 *  - Model not found / auth errors
 *  - SQL extraction from markdown fences
 */

import { OpenAILLM } from '../../src/llm/OpenAILLM';
import type { LLMConfig, EnrichedTable, RawTable } from '../../src/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testConfig: LLMConfig = {
  provider: 'openai',
  apiKey: 'sk-test-key-12345',
  model: 'gpt-4o-mini',
  temperature: 0.1,
};

function makeRawTable(tableName = 'orders'): RawTable {
  return {
    tableName,
    tableComment: 'Customer orders',
    tableRows: 5000,
    columns: [
      { columnName: 'id',           dataType: 'int',     isNullable: 'NO',  ordinalPosition: 1, columnDefault: null, extra: 'auto_increment', columnKey: 'PRI', columnComment: '' },
      { columnName: 'total_amount', dataType: 'decimal', isNullable: 'NO',  ordinalPosition: 2, columnDefault: null, extra: '',               columnKey: '',    columnComment: 'Order total in KES', sampleValues: '500, 1200, 3500' },
      { columnName: 'status',       dataType: 'varchar', isNullable: 'NO',  ordinalPosition: 3, columnDefault: null, extra: '',               columnKey: '',    columnComment: '', sampleValues: 'pending, shipped, delivered' },
    ],
    foreignKeys: [],
  };
}

function makeEnrichedTable(): EnrichedTable {
  return {
    tableName: 'orders',
    businessName: 'Customer Orders',
    description: 'All purchases made by customers.',
    useCases: ['How many orders last month?'],
    synonyms: ['purchases'],
    columns: [
      { name: 'id',           businessLabel: 'Order ID',    description: 'Unique ID',     synonyms: [],          exampleQuestions: [] },
      { name: 'total_amount', businessLabel: 'Order Total', description: 'Total in KES',  synonyms: ['amount'],  exampleQuestions: [] },
      { name: 'status',       businessLabel: 'Status',      description: 'Order status',  synonyms: ['state'],   exampleQuestions: [] },
    ],
    enrichedAt: '2024-01-01T00:00:00Z',
    schemaHash: 'abc123',
  };
}

/**
 * Helper that creates a mock fetch response with the given body and status.
 */
function mockFetchResponse(body: object, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

/**
 * Builds the standard OpenAI success response shape for a given content string.
 */
function openAISuccess(content: string) {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OpenAILLM', () => {
  let llm: OpenAILLM;

  beforeEach(() => {
    llm = new OpenAILLM(testConfig);
    // Reset fetch mock before each test
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('generateSQL()', () => {
    it('returns SQL from a successful API response', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(openAISuccess('SELECT orders.id, orders.status FROM orders LIMIT 1000'))
      );

      const sql = await llm.generateSQL('show all orders', [makeEnrichedTable()]);
      expect(sql).toBe('SELECT orders.id, orders.status FROM orders LIMIT 1000');
    });

    it('strips markdown code fences from the response', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(openAISuccess('```sql\nSELECT orders.id FROM orders\n```'))
      );

      const sql = await llm.generateSQL('show orders', [makeEnrichedTable()]);
      expect(sql).toBe('SELECT orders.id FROM orders');
    });

    it('sends the request to the correct OpenAI endpoint', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(openAISuccess('SELECT 1'))
      );

      await llm.generateSQL('test', [makeEnrichedTable()]);

      const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
    });

    it('includes the Authorization header with the API key', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(openAISuccess('SELECT 1'))
      );

      await llm.generateSQL('test', [makeEnrichedTable()]);

      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk-test-key-12345');
    });

    it('includes the model name in the request body', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(openAISuccess('SELECT 1'))
      );

      await llm.generateSQL('test', [makeEnrichedTable()]);

      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('gpt-4o-mini');
    });

    it('includes few-shot examples as conversation turns', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(openAISuccess('SELECT 1'))
      );

      const examples = [{ question: 'How many orders?', sql: 'SELECT COUNT(*) FROM orders' }];
      await llm.generateSQL('test', [makeEnrichedTable()], examples);

      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      const messages: Array<{role: string; content: string}> = body.messages;

      // Should contain a user message with the example question
      expect(messages.some((m) => m.role === 'user' && m.content === 'How many orders?')).toBe(true);
      // And an assistant message with the example SQL
      expect(messages.some((m) => m.role === 'assistant' && m.content === 'SELECT COUNT(*) FROM orders')).toBe(true);
    });

    it('throws a descriptive error when the API returns an error', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse({ error: { message: 'Invalid API key', type: 'auth_error', code: 'invalid_api_key' } }, 401)
      );

      await expect(llm.generateSQL('test', [makeEnrichedTable()]))
        .rejects.toThrow('Invalid API key');
    });

    it('throws a network error message when fetch fails', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Connection refused'));

      await expect(llm.generateSQL('test', [makeEnrichedTable()]))
        .rejects.toThrow('Connection refused');
    });

    it('throws when the response has empty choices', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse({ choices: [] })
      );

      await expect(llm.generateSQL('test', [makeEnrichedTable()]))
        .rejects.toThrow('empty response');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('enrichTable()', () => {
    const validEnrichmentJSON = JSON.stringify({
      businessName: 'Customer Orders',
      description: 'All purchases made by customers.',
      useCases: ['How many orders last month?'],
      synonyms: ['purchases', 'transactions'],
      columns: [
        { name: 'id',           businessLabel: 'Order ID',    description: 'Unique identifier', synonyms: [],         exampleQuestions: ['Find order 123'] },
        { name: 'total_amount', businessLabel: 'Order Total', description: 'Total in KES',       synonyms: ['amount'], exampleQuestions: ['Average order value?'] },
        { name: 'status',       businessLabel: 'Status',      description: 'Current status',     synonyms: ['state'],  exampleQuestions: ['Show pending orders'] },
      ],
    });

    it('returns a fully populated EnrichedTable on success', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(openAISuccess(validEnrichmentJSON))
      );

      const result = await llm.enrichTable(makeRawTable(), 'hash123');

      expect(result.tableName).toBe('orders');
      expect(result.businessName).toBe('Customer Orders');
      expect(result.description).toContain('purchases');
      expect(result.synonyms).toContain('transactions');
      expect(result.schemaHash).toBe('hash123');
      expect(result.enrichedAt).toBeTruthy();
    });

    it('maps column enrichments correctly', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(openAISuccess(validEnrichmentJSON))
      );

      const result = await llm.enrichTable(makeRawTable(), 'hash123');

      const totalCol = result.columns.find((c) => c.name === 'total_amount');
      expect(totalCol).toBeDefined();
      expect(totalCol!.businessLabel).toBe('Order Total');
      expect(totalCol!.synonyms).toContain('amount');
    });

    it('falls back gracefully for columns the LLM missed', async () => {
      // Return enrichment with only one column described
      const partialJSON = JSON.stringify({
        businessName: 'Orders',
        description: 'Orders table.',
        useCases: [],
        synonyms: [],
        columns: [
          { name: 'id', businessLabel: 'Order ID', description: 'ID', synonyms: [], exampleQuestions: [] },
          // 'total_amount' and 'status' are missing from LLM response
        ],
      });

      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(openAISuccess(partialJSON))
      );

      const result = await llm.enrichTable(makeRawTable(), 'hash123');

      // Should still have all 3 columns (fallback for missing ones)
      expect(result.columns).toHaveLength(3);
      const totalCol = result.columns.find((c) => c.name === 'total_amount');
      expect(totalCol!.businessLabel).toBe('total_amount'); // fell back to column name
    });

    it('enables JSON mode in the request', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(openAISuccess(validEnrichmentJSON))
      );

      await llm.enrichTable(makeRawTable(), 'hash123');

      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.response_format?.type).toBe('json_object');
    });

    it('throws when the LLM returns malformed JSON', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(openAISuccess('This is not JSON at all'))
      );

      await expect(llm.enrichTable(makeRawTable(), 'hash123'))
        .rejects.toThrow('Could not parse');
    });

    it('throws when required fields are missing from the response', async () => {
      const incompleteJSON = JSON.stringify({ businessName: 'Orders' }); // missing description + columns

      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(openAISuccess(incompleteJSON))
      );

      await expect(llm.enrichTable(makeRawTable(), 'hash123'))
        .rejects.toThrow('missing field');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('custom baseURL', () => {
    it('uses the custom baseURL when provided', async () => {
      const customConfig = {
        ...testConfig,
        baseURL: 'https://my-openai-proxy.example.com/v1',
      } as LLMConfig & { baseURL: string };

      const customLLM = new OpenAILLM(customConfig);
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(openAISuccess('SELECT 1'))
      );

      await customLLM.generateSQL('test', [makeEnrichedTable()]);

      const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect(url).toContain('my-openai-proxy.example.com');
    });
  });
});
