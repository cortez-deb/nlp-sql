/**
 * llm/BaseLLM.ts
 *
 * This file defines the contract (interface) that every LLM provider
 * must implement. By using an abstract class, we ensure that:
 *
 *  1. Every provider (Gemini, future OpenAI, etc.) has the same methods
 *  2. The rest of the library doesn't need to know which provider is in use
 *  3. Adding a new provider is simply a matter of creating a new class
 *     that extends BaseLLM
 *
 * This is the "Strategy Pattern" — the algorithm (which LLM to call)
 * is swappable at runtime without changing any other code.
 */

import type { LLMConfig, EnrichedTable, RawTable, FewShotExample } from '../types';

/**
 * Abstract base class for all LLM provider implementations.
 *
 * Do not use this class directly — use a concrete subclass such as GeminiLLM.
 *
 * To add a new LLM provider, create a class that extends BaseLLM and
 * implement the two abstract methods: `enrichTable` and `generateSQL`.
 */
export abstract class BaseLLM {
  /**
   * The configuration passed in by the user, including the API key and model name.
   * Stored as protected so subclasses can access it.
   */
  protected readonly config: LLMConfig;

  /**
   * @param config - LLM provider configuration including API key and model.
   */
  constructor(config: LLMConfig) {
    this.config = config;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ABSTRACT METHODS (must be implemented by every subclass)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sends a raw table definition to the LLM and asks it to produce an
   * enriched, business-friendly description of the table and its columns.
   *
   * This is the core of the "LLM-Generated Business Layer" strategy.
   * It runs once per table during the enrichment phase.
   *
   * @param rawTable     - The raw schema data for the table.
   * @param schemaHash   - Hash of the raw schema (stored with the enrichment
   *                       so we can detect future schema changes).
   * @returns An EnrichedTable with business names, descriptions, and synonyms.
   * @throws Error if the LLM call fails or returns malformed output.
   */
  abstract enrichTable(rawTable: RawTable, schemaHash: string): Promise<EnrichedTable>;

  /**
   * Sends a user's natural language question (plus relevant schema context)
   * to the LLM and asks it to return a MySQL SELECT query.
   *
   * @param userQuery      - The plain-English question from the user.
   * @param contextTables  - Enriched descriptions of the most relevant tables,
   *                         assembled into the prompt as schema context.
   * @param fewShotExamples - Optional worked examples to guide the LLM.
   * @returns The raw SQL string produced by the LLM.
   * @throws Error if the LLM call fails.
   */
  abstract generateSQL(
    userQuery: string,
    contextTables: EnrichedTable[],
    fewShotExamples?: FewShotExample[]
  ): Promise<string>;

  // ─────────────────────────────────────────────────────────────────────────
  // SHARED HELPERS (available to all subclasses)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Builds the schema context block injected into the SQL generation prompt.
   *
   * Converts a list of EnrichedTable objects into a human+LLM-readable text
   * block that describes which tables are available and what they mean.
   * This is the text the LLM uses to understand your database.
   *
   * @param tables - Enriched table descriptions to include in the prompt.
   * @returns A formatted multi-line string ready to embed in a prompt.
   *
   * @example
   * // Output looks like:
   * // TABLE: orders (Customer Orders)
   * // Description: Records every purchase a customer has placed...
   * // Synonyms: purchases, transactions, sales
   * // Columns:
   * //   - order_id [int] → Order ID
   * //   ...
   */
  protected buildSchemaContext(tables: EnrichedTable[]): string {
    return tables
      .map((table) => {
        const lines: string[] = [
          `TABLE: ${table.tableName} (${table.businessName})`,
          `Description: ${table.description}`,
          `Synonyms: ${table.synonyms.join(', ')}`,
          `Columns:`,
        ];

        for (const col of table.columns) {
          lines.push(
            `  - ${col.name} → "${col.businessLabel}": ${col.description}` +
            (col.synonyms.length > 0 ? ` (also called: ${col.synonyms.join(', ')})` : '')
          );
        }

        return lines.join('\n');
      })
      .join('\n\n');
  }

  /**
   * Builds the few-shot examples block for the SQL generation prompt.
   *
   * Few-shot examples show the LLM what good question→SQL pairs look like
   * for your specific database, dramatically improving accuracy.
   *
   * @param examples - Array of question/SQL example pairs.
   * @returns A formatted string of examples, or empty string if none provided.
   */
  protected buildFewShotBlock(examples: FewShotExample[]): string {
    if (examples.length === 0) return '';

    const exampleText = examples
      .map((ex) => `Q: ${ex.question}\nSQL: ${ex.sql}`)
      .join('\n\n');

    return `EXAMPLES (follow this pattern):\n${exampleText}`;
  }

  /**
   * Cleans the raw text returned by an LLM to extract just the SQL.
   *
   * LLMs often wrap their output in markdown code fences like:
   *   ```sql
   *   SELECT ...
   *   ```
   *
   * This method strips those fences and any surrounding whitespace.
   *
   * @param raw - The raw text string returned by the LLM.
   * @returns The extracted SQL string.
   */
  protected extractSQL(raw: string): string {
    let cleaned = raw.trim();

    // Remove markdown code fences: ```sql ... ``` or ``` ... ```
    cleaned = cleaned.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/, '');

    // Trim again after fence removal
    cleaned = cleaned.trim();

    return cleaned;
  }

  /**
   * Attempts to parse a JSON response from the LLM.
   *
   * LLMs sometimes wrap JSON in markdown code fences or add
   * explanatory text before/after it. This method extracts the
   * JSON object robustly.
   *
   * @param raw - Raw LLM output that should contain JSON.
   * @returns The parsed JavaScript object.
   * @throws SyntaxError if no valid JSON can be found.
   */
  protected extractJSON<T>(raw: string): T {
    let cleaned = raw.trim();

    // Remove markdown fences
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    cleaned = cleaned.trim();

    // Find the first { and last } in case the LLM added preamble
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
