/**
 * tests/unit/OllamaLLM.test.ts
 *
 * Unit tests for the OllamaLLM class.
 *
 * All HTTP calls to the Ollama server are mocked — no local Ollama
 * installation is needed to run these tests.
 *
 * Tests cover:
 *  - Successful SQL generation
 *  - Successful table enrichment
 *  - Ollama not running (connection refused)
 *  - Model not found (404)
 *  - checkServer() utility method
 *  - Custom baseURL support
 */

import { OllamaLLM } from '../../src/llm/OllamaLLM';
import type { OllamaConfig } from '../../src/llm/OllamaLLM';
import type { EnrichedTable, RawTable } from '../../src/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testConfig: OllamaConfig = {
  provider: 'ollama',
  apiKey: '',            // Not needed for Ollama
  model: 'llama3.1',
  temperature: 0.1,
  baseURL: 'http://localhost:11434',
};

function makeRawTable(tableName = 'products'): RawTable {
  return {
    tableName,
    tableComment: '',
    tableRows: 200,
    columns: [
      { columnName: 'id',    dataType: 'int',     isNullable: 'NO',  ordinalPosition: 1, columnDefault: null, extra: 'auto_increment', columnKey: 'PRI', columnComment: '' },
      { columnName: 'name',  dataType: 'varchar', isNullable: 'NO',  ordinalPosition: 2, columnDefault: null, extra: '',               columnKey: '',    columnComment: '' },
      { columnName: 'price', dataType: 'decimal', isNullable: 'NO',  ordinalPosition: 3, columnDefault: null, extra: '',               columnKey: '',    columnComment: '', sampleValues: '500, 1500, 9999' },
    ],
    foreignKeys: [],
  };
}

function makeEnrichedTable(): EnrichedTable {
  return {
    tableName: 'products',
    businessName: 'Product Catalogue',
    description: 'Items available for sale.',
    useCases: ['Show all products'],
    synonyms: ['items', 'inventory'],
    columns: [
      { name: 'id',    businessLabel: 'Product ID',    description: 'Unique ID',     synonyms: [],         exampleQuestions: [] },
      { name: 'name',  businessLabel: 'Product Name',  description: 'Product title', synonyms: ['title'],  exampleQuestions: [] },
      { name: 'price', businessLabel: 'Price',         description: 'Selling price', synonyms: ['cost'],   exampleQuestions: [] },
    ],
    enrichedAt: '2024-01-01T00:00:00Z',
    schemaHash: 'def456',
  };
}

/** Creates a mock Ollama /api/chat response */
function ollamaSuccess(content: string) {
  return {
    message: { role: 'assistant', content },
    done: true,
  };
}

function mockFetchResponse(body: object, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OllamaLLM', () => {
  let llm: OllamaLLM;

  beforeEach(() => {
    llm = new OllamaLLM(testConfig);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('generateSQL()', () => {
    it('returns SQL from a successful Ollama response', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(ollamaSuccess('SELECT products.id, products.name FROM products LIMIT 1000'))
      );

      const sql = await llm.generateSQL('show all products', [makeEnrichedTable()]);
      expect(sql).toBe('SELECT products.id, products.name FROM products LIMIT 1000');
    });

    it('strips markdown fences from the response', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(ollamaSuccess('```sql\nSELECT products.id FROM products\n```'))
      );

      const sql = await llm.generateSQL('test', [makeEnrichedTable()]);
      expect(sql).toBe('SELECT products.id FROM products');
    });

    it('sends the request to the correct Ollama endpoint', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(ollamaSuccess('SELECT 1'))
      );

      await llm.generateSQL('test', [makeEnrichedTable()]);

      const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:11434/api/chat');
    });

    it('sends stream: false in the request body', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(ollamaSuccess('SELECT 1'))
      );

      await llm.generateSQL('test', [makeEnrichedTable()]);

      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.stream).toBe(false);
    });

    it('includes the model name in the request', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(ollamaSuccess('SELECT 1'))
      );

      await llm.generateSQL('test', [makeEnrichedTable()]);

      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('llama3.1');
    });

    it('throws a helpful error when Ollama is not running', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(llm.generateSQL('test', [makeEnrichedTable()]))
        .rejects.toThrow('ollama serve');
    });

    it('throws a helpful error when the model is not found (404)', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse({ error: 'model not found' }, 404)
      );

      await expect(llm.generateSQL('test', [makeEnrichedTable()]))
        .rejects.toThrow('ollama pull llama3.1');
    });

    it('throws when Ollama returns an empty response', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse({ message: { role: 'assistant', content: '' }, done: true })
      );

      await expect(llm.generateSQL('test', [makeEnrichedTable()]))
        .rejects.toThrow('empty response');
    });

    it('uses a custom baseURL when configured', async () => {
      const remoteConfig: OllamaConfig = {
        ...testConfig,
        baseURL: 'http://192.168.1.100:11434',
      };
      const remoteLLM = new OllamaLLM(remoteConfig);

      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(ollamaSuccess('SELECT 1'))
      );

      await remoteLLM.generateSQL('test', [makeEnrichedTable()]);

      const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect(url).toContain('192.168.1.100:11434');
    });

    it('strips trailing slash from baseURL', async () => {
      const config: OllamaConfig = { ...testConfig, baseURL: 'http://localhost:11434/' };
      const llmWithSlash = new OllamaLLM(config);

      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(ollamaSuccess('SELECT 1'))
      );

      await llmWithSlash.generateSQL('test', [makeEnrichedTable()]);

      const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      // Should not have double slashes
      expect(url).toBe('http://localhost:11434/api/chat');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('enrichTable()', () => {
    const validJSON = JSON.stringify({
      businessName: 'Product Catalogue',
      description: 'Items available for sale.',
      useCases: ['What products do we sell?'],
      synonyms: ['items', 'inventory'],
      columns: [
        { name: 'id',    businessLabel: 'Product ID',   description: 'Unique ID',     synonyms: [],        exampleQuestions: [] },
        { name: 'name',  businessLabel: 'Product Name', description: 'Name of item',  synonyms: ['title'], exampleQuestions: [] },
        { name: 'price', businessLabel: 'Price',        description: 'Selling price', synonyms: ['cost'],  exampleQuestions: [] },
      ],
    });

    it('returns a correctly populated EnrichedTable', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(ollamaSuccess(validJSON))
      );

      const result = await llm.enrichTable(makeRawTable(), 'hash456');

      expect(result.tableName).toBe('products');
      expect(result.businessName).toBe('Product Catalogue');
      expect(result.schemaHash).toBe('hash456');
      expect(result.columns).toHaveLength(3);
    });

    it('sets format: json in the request body for JSON mode', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(ollamaSuccess(validJSON))
      );

      await llm.enrichTable(makeRawTable(), 'hash456');

      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.format).toBe('json');
    });

    it('throws with a helpful message when JSON parsing fails', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse(ollamaSuccess('Sorry, I cannot help with that.'))
      );

      await expect(llm.enrichTable(makeRawTable(), 'hash'))
        .rejects.toThrow('Try a different model');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('OllamaLLM.checkServer()', () => {
    it('returns running: false when the server is unreachable', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

      const status = await OllamaLLM.checkServer('http://localhost:11434');
      expect(status.running).toBe(false);
      expect(status.modelAvailable).toBe(false);
      expect(status.availableModels).toHaveLength(0);
    });

    it('returns running: true with model list when server is up', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse({
          models: [
            { name: 'llama3.1:latest' },
            { name: 'mistral:latest' },
            { name: 'codellama:7b' },
          ],
        })
      );

      const status = await OllamaLLM.checkServer('http://localhost:11434');
      expect(status.running).toBe(true);
      expect(status.availableModels).toHaveLength(3);
    });

    it('returns modelAvailable: true when the model is present', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse({ models: [{ name: 'llama3.1:latest' }, { name: 'mistral:latest' }] })
      );

      const status = await OllamaLLM.checkServer('http://localhost:11434', 'llama3.1');
      expect(status.modelAvailable).toBe(true);
    });

    it('returns modelAvailable: false when the model is not present', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse({ models: [{ name: 'mistral:latest' }] })
      );

      const status = await OllamaLLM.checkServer('http://localhost:11434', 'llama3.1');
      expect(status.modelAvailable).toBe(false);
    });

    it('returns modelAvailable: true when no model filter is given', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse({ models: [{ name: 'mistral:latest' }] })
      );

      // No model specified — just checking if server is up
      const status = await OllamaLLM.checkServer('http://localhost:11434');
      expect(status.running).toBe(true);
      expect(status.modelAvailable).toBe(true);
    });

    it('returns running: false for non-200 responses', async () => {
      (global.fetch as jest.Mock).mockReturnValue(
        mockFetchResponse({}, 503)
      );

      const status = await OllamaLLM.checkServer();
      expect(status.running).toBe(false);
    });
  });
});
