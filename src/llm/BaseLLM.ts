/**
 * llm/BaseLLM.ts
 */

import type {
  LLMConfig,
  EnrichedTable,
  RawTable,
  FewShotExample,
  ConversationTurn,
} from '../types';

export type { ConversationTurn };

export interface GenerateSQLInput {
  question: string;
  contextTables: EnrichedTable[];
  fewShotExamples?: FewShotExample[];
  dialect?: string;
  history?: ConversationTurn[];
  previousAttempt?: { sql: string; error: string };
  currentDate?: string;
}

export interface SummarizeInput {
  question: string;
  sql: string;
  rows: Record<string, unknown>[];
  totalRowCount: number;
  truncated: boolean;
  maxChars: number;
}

export abstract class BaseLLM {
  protected readonly config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  abstract enrichTable(rawTable: RawTable, schemaHash: string): Promise<EnrichedTable>;

  abstract generateSQL(input: GenerateSQLInput): Promise<string>;

  abstract summarizeResult(input: SummarizeInput): Promise<string>;

  protected buildSchemaContext(tables: EnrichedTable[]): string {
    return tables
      .map((table) => {
        const rowsApprox = (table.rowCountApprox ?? 0).toLocaleString();
        const lines: string[] = [
          `TABLE ${table.tableName}  -- ${table.businessName} (~${rowsApprox} rows)`,
        ];

        if (table.primaryKey && table.primaryKey.length > 0) {
          lines.push(`  PK: ${table.primaryKey.join(', ')}`);
        }

        if (table.foreignKeys && table.foreignKeys.length > 0) {
          for (const fk of table.foreignKeys) {
            lines.push(`  FK: ${fk.columnName} -> ${fk.referencedTable}.${fk.referencedColumn}`);
          }
        }

        lines.push(`  Columns:`);

        for (const col of table.columns) {
          const colType = (col.columnType || col.dataType || '').toUpperCase();

          const isPK = table.primaryKey?.includes(col.name) || col.columnKey === 'PRI';
          const fk = table.foreignKeys?.find((f) => f.columnName === col.name);

          let badge = '';
          if (isPK) {
            badge += ' PK';
          }
          if (fk) {
            badge += ` FK->${fk.referencedTable}.${fk.referencedColumn}`;
          }

          let sampleText = '';
          if (
            col.sampleValues &&
            !colType.toLowerCase().startsWith('enum') &&
            !colType.toLowerCase().startsWith('set')
          ) {
            const samples = col.sampleValues.split(', ').filter((s) => s.trim().length > 0);
            if (samples.length > 0 && samples.length <= 5) {
              sampleText = `   (sample: ${col.sampleValues})`;
            }
          }

          lines.push(`    ${table.tableName}.${col.name} ${colType}${badge} — ${col.description}${sampleText}`);
        }

        return lines.join('\n');
      })
      .join('\n\n');
  }

  protected buildFewShotBlock(examples: FewShotExample[]): string {
    if (examples.length === 0) return '';

    const exampleText = examples
      .map((ex) => `Q: ${ex.question}\nSQL: ${ex.sql}`)
      .join('\n\n');

    return `EXAMPLES (follow this pattern):\n${exampleText}`;
  }

  protected extractSQL(raw: string): string {
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/, '');
    return cleaned.trim();
  }

  protected extractJSON<T>(raw: string): T {
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    cleaned = cleaned.trim();

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');

    if (start === -1 || end === -1) {
      throw new SyntaxError(
        `LLM response did not contain valid JSON. Response was: ${raw.substring(0, 200)}...`
      );
    }

    return JSON.parse(cleaned.substring(start, end + 1)) as T;
  }
}
