/**
 * tests/unit/BaseLLM.test.ts
 *
 * Tests for the shared helper methods on BaseLLM.
 *
 * Since BaseLLM is abstract (cannot be instantiated directly), we create
 * a minimal "TestLLM" subclass that exposes the protected methods for testing.
 * This is a common pattern when unit testing abstract base classes.
 */

import { BaseLLM } from '../../src/llm/BaseLLM';
import type { EnrichedTable, RawTable, FewShotExample, LLMConfig } from '../../src/types';

// ── Minimal concrete subclass to test BaseLLM's helpers ───────────────────────

class TestLLM extends BaseLLM {
  // Implement abstract methods with stubs (they won't be called in these tests)
  async enrichTable(_rawTable: RawTable, _schemaHash: string): Promise<EnrichedTable> {
    throw new Error('Not implemented in TestLLM');
  }

  async generateSQL(
    _userQuery: string,
    _contextTables: EnrichedTable[],
    _fewShotExamples?: FewShotExample[]
  ): Promise<string> {
    throw new Error('Not implemented in TestLLM');
  }

  // Expose protected methods as public so tests can call them
  public testBuildSchemaContext(tables: EnrichedTable[]): string {
    return this.buildSchemaContext(tables);
  }

  public testBuildFewShotBlock(examples: FewShotExample[]): string {
    return this.buildFewShotBlock(examples);
  }

  public testExtractSQL(raw: string): string {
    return this.extractSQL(raw);
  }

  public testExtractJSON<T>(raw: string): T {
    return this.extractJSON<T>(raw);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testConfig: LLMConfig = {
  provider: 'gemini',
  apiKey: 'test-api-key',
  model: 'gemini-1.5-flash-latest',
};

function makeEnrichedTable(tableName = 'orders'): EnrichedTable {
  return {
    tableName,
    businessName: 'Customer Orders',
    description: 'All purchases made by customers.',
    useCases: ['How many orders last month?'],
    synonyms: ['purchases', 'transactions'],
    columns: [
      {
        name: 'id',
        businessLabel: 'Order ID',
        description: 'Unique identifier.',
        synonyms: [],
        exampleQuestions: [],
      },
      {
        name: 'total_amount',
        businessLabel: 'Order Total',
        description: 'The monetary value.',
        synonyms: ['total', 'price'],
        exampleQuestions: ['What is the average total?'],
      },
    ],
    enrichedAt: '2024-01-01T00:00:00Z',
    schemaHash: 'abc',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BaseLLM (via TestLLM)', () => {
  let llm: TestLLM;

  beforeEach(() => {
    llm = new TestLLM(testConfig);
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('buildSchemaContext()', () => {
    it('includes the table name and business name', () => {
      const context = llm.testBuildSchemaContext([makeEnrichedTable('orders')]);
      expect(context).toContain('orders');
      expect(context).toContain('Customer Orders');
    });

    it('includes the table description', () => {
      const context = llm.testBuildSchemaContext([makeEnrichedTable()]);
      expect(context).toContain('All purchases made by customers.');
    });

    it('includes column names and business labels', () => {
      const context = llm.testBuildSchemaContext([makeEnrichedTable()]);
      expect(context).toContain('id');
      expect(context).toContain('Order ID');
      expect(context).toContain('total_amount');
      expect(context).toContain('Order Total');
    });

    it('includes column synonyms', () => {
      const context = llm.testBuildSchemaContext([makeEnrichedTable()]);
      expect(context).toContain('total');
      expect(context).toContain('price');
    });

    it('includes table synonyms', () => {
      const context = llm.testBuildSchemaContext([makeEnrichedTable()]);
      expect(context).toContain('purchases');
      expect(context).toContain('transactions');
    });

    it('handles multiple tables', () => {
      const tables = [makeEnrichedTable('orders'), makeEnrichedTable('customers')];
      const context = llm.testBuildSchemaContext(tables);
      expect(context).toContain('orders');
      expect(context).toContain('customers');
    });

    it('returns empty string for empty table list', () => {
      const context = llm.testBuildSchemaContext([]);
      expect(context).toBe('');
    });

    it('does not include synonyms section when column has no synonyms', () => {
      const tableWithNoSynonyms = makeEnrichedTable();
      tableWithNoSynonyms.columns[0]!.synonyms = [];
      const context = llm.testBuildSchemaContext([tableWithNoSynonyms]);
      // The "id" column has no synonyms — "also called" should not appear for it
      // We check context doesn't say "also called: " with empty content
      expect(context).not.toContain('also called: )');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('buildFewShotBlock()', () => {
    it('returns empty string when no examples are provided', () => {
      expect(llm.testBuildFewShotBlock([])).toBe('');
    });

    it('includes the question and SQL from each example', () => {
      const examples: FewShotExample[] = [
        { question: 'How many users?', sql: 'SELECT COUNT(*) FROM users' },
      ];
      const block = llm.testBuildFewShotBlock(examples);
      expect(block).toContain('How many users?');
      expect(block).toContain('SELECT COUNT(*) FROM users');
    });

    it('includes all examples when multiple are provided', () => {
      const examples: FewShotExample[] = [
        { question: 'Q1', sql: 'SELECT 1' },
        { question: 'Q2', sql: 'SELECT 2' },
        { question: 'Q3', sql: 'SELECT 3' },
      ];
      const block = llm.testBuildFewShotBlock(examples);
      expect(block).toContain('Q1');
      expect(block).toContain('Q2');
      expect(block).toContain('Q3');
      expect(block).toContain('SELECT 1');
      expect(block).toContain('SELECT 2');
      expect(block).toContain('SELECT 3');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('extractSQL()', () => {
    it('returns plain SQL unchanged', () => {
      const sql = 'SELECT id FROM users';
      expect(llm.testExtractSQL(sql)).toBe(sql);
    });

    it('strips ```sql ... ``` markdown fences', () => {
      const raw = '```sql\nSELECT id FROM users\n```';
      expect(llm.testExtractSQL(raw)).toBe('SELECT id FROM users');
    });

    it('strips ``` ... ``` fences without language tag', () => {
      const raw = '```\nSELECT id FROM users\n```';
      expect(llm.testExtractSQL(raw)).toBe('SELECT id FROM users');
    });

    it('trims surrounding whitespace', () => {
      const raw = '\n\n  SELECT id FROM users  \n\n';
      expect(llm.testExtractSQL(raw)).toBe('SELECT id FROM users');
    });

    it('handles multi-line SQL correctly', () => {
      const raw = '```sql\nSELECT id,\n  name\nFROM users\nLIMIT 10\n```';
      const extracted = llm.testExtractSQL(raw);
      expect(extracted).toContain('SELECT id,');
      expect(extracted).toContain('name');
      expect(extracted).toContain('LIMIT 10');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('extractJSON()', () => {
    it('parses plain JSON', () => {
      const raw = '{"key": "value", "num": 42}';
      const parsed = llm.testExtractJSON<{ key: string; num: number }>(raw);
      expect(parsed.key).toBe('value');
      expect(parsed.num).toBe(42);
    });

    it('strips ```json ... ``` fences before parsing', () => {
      const raw = '```json\n{"key": "value"}\n```';
      const parsed = llm.testExtractJSON<{ key: string }>(raw);
      expect(parsed.key).toBe('value');
    });

    it('extracts JSON from text with preamble', () => {
      const raw = 'Here is the result:\n{"key": "value"}';
      const parsed = llm.testExtractJSON<{ key: string }>(raw);
      expect(parsed.key).toBe('value');
    });

    it('throws SyntaxError for text with no JSON object', () => {
      expect(() => llm.testExtractJSON('This is just plain text')).toThrow(SyntaxError);
    });

    it('parses nested JSON objects', () => {
      const raw = '{"a": {"b": {"c": 42}}}';
      const parsed = llm.testExtractJSON<{ a: { b: { c: number } } }>(raw);
      expect(parsed.a.b.c).toBe(42);
    });

    it('parses JSON arrays inside objects', () => {
      const raw = '{"items": [1, 2, 3], "name": "test"}';
      const parsed = llm.testExtractJSON<{ items: number[]; name: string }>(raw);
      expect(parsed.items).toEqual([1, 2, 3]);
      expect(parsed.name).toBe('test');
    });
  });
});
