/**
 * tests/unit/BaseLLM.test.ts
 */

import { BaseLLM } from '../../src/llm/BaseLLM';
import type { GenerateSQLInput, SummarizeInput } from '../../src/llm/BaseLLM';
import type { EnrichedTable, RawTable, FewShotExample, LLMConfig } from '../../src/types';

class TestLLM extends BaseLLM {
  async enrichTable(_rawTable: RawTable, _schemaHash: string): Promise<EnrichedTable> {
    throw new Error('Not implemented in TestLLM');
  }

  async generateSQL(_input: GenerateSQLInput): Promise<string> {
    throw new Error('Not implemented in TestLLM');
  }

  async summarizeResult(_input: SummarizeInput): Promise<string> {
    throw new Error('Not implemented in TestLLM');
  }

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

const testConfig: LLMConfig = {
  provider: 'gemini',
  apiKey: 'test-api-key',
  model: 'gemini-2.0-flash',
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
        dataType: 'int',
        columnType: 'int',
        columnKey: 'PRI',
      },
      {
        name: 'total_amount',
        businessLabel: 'Order Total',
        description: 'The monetary value.',
        synonyms: ['total', 'price'],
        exampleQuestions: ['What is the average total?'],
        dataType: 'decimal',
        columnType: 'decimal(10,2)',
        columnKey: '',
        sampleValues: '12.50, 99.00',
      },
    ],
    foreignKeys: [],
    primaryKey: ['id'],
    rowCountApprox: 12000,
    enrichedAt: '2024-01-01T00:00:00Z',
    schemaHash: 'abc',
  };
}

describe('BaseLLM (via TestLLM)', () => {
  let llm: TestLLM;

  beforeEach(() => {
    llm = new TestLLM(testConfig);
  });

  describe('buildSchemaContext()', () => {
    it('includes table header, business name, PK, and columns', () => {
      const context = llm.testBuildSchemaContext([makeEnrichedTable('orders')]);
      expect(context).toContain('TABLE orders  -- Customer Orders (~12,000 rows)');
      expect(context).toContain('PK: id');
      expect(context).toContain('orders.id INT PK — Unique identifier.');
      expect(context).toContain('orders.total_amount DECIMAL(10,2) — The monetary value.   (sample: 12.50, 99.00)');
    });

    it('returns empty string for empty table list', () => {
      const context = llm.testBuildSchemaContext([]);
      expect(context).toBe('');
    });
  });

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
  });

  describe('extractSQL()', () => {
    it('returns plain SQL unchanged', () => {
      const sql = 'SELECT id FROM users';
      expect(llm.testExtractSQL(sql)).toBe(sql);
    });

    it('strips ```sql ... ``` markdown fences', () => {
      const raw = '```sql\nSELECT id FROM users\n```';
      expect(llm.testExtractSQL(raw)).toBe('SELECT id FROM users');
    });
  });

  describe('extractJSON()', () => {
    it('parses plain JSON', () => {
      const raw = '{"key": "value", "num": 42}';
      const parsed = llm.testExtractJSON<{ key: string; num: number }>(raw);
      expect(parsed.key).toBe('value');
      expect(parsed.num).toBe(42);
    });

    it('throws SyntaxError for text with no JSON object', () => {
      expect(() => llm.testExtractJSON('This is just plain text')).toThrow(SyntaxError);
    });
  });
});
