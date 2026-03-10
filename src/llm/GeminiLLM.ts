/**
 * llm/GeminiLLM.ts
 *
 * Concrete implementation of BaseLLM using Google's Gemini API.
 * This class knows how to:
 *  1. Talk to the Gemini API using the @google/generative-ai SDK
 *  2. Format enrichment prompts and parse the JSON responses
 *  3. Format SQL generation prompts and extract the SQL from responses
 *
 * Users of the library configure this class via LLMConfig and never
 * call the Gemini SDK directly.
 */

import {
  GoogleGenerativeAI,
  GenerativeModel,
  HarmCategory,
  HarmBlockThreshold,
} from '@google/generative-ai';

import { BaseLLM } from './BaseLLM';
import type { LLMConfig, EnrichedTable, RawTable, FewShotExample } from '../types';

/**
 * Describes the JSON structure we ask Gemini to return when enriching a table.
 * This is an internal type — it reflects the LLM's output before we clean it up.
 */
interface EnrichmentResponse {
  businessName: string;
  description: string;
  useCases: string[];
  synonyms: string[];
  columns: Array<{
    name: string;
    businessLabel: string;
    description: string;
    synonyms: string[];
    exampleQuestions: string[];
  }>;
}

/**
 * GeminiLLM uses Google's Gemini models to power the nlsql library.
 *
 * Supports any Gemini model name passed in via LLMConfig.model.
 *
 * ⚠️  Model names change over time. Always check the current list with:
 *     https://ai.google.dev/gemini-api/docs/models/gemini
 *
 * Common working model names (as of 2025):
 *  - 'gemini-1.5-flash-latest'   (fast, cost-effective — recommended default)
 *  - 'gemini-1.5-pro-latest'     (higher quality, slower)
 *  - 'gemini-2.0-flash'          (latest generation fast model)
 *  - 'gemini-2.0-flash-lite'     (lightest/cheapest option)
 *
 * If you get a 404 "model not found" error, run this to list available models:
 *   curl https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_API_KEY
 *
 * @example
 * const llm = new GeminiLLM({
 *   provider: 'gemini',
 *   apiKey: process.env.GEMINI_API_KEY!,
 *   model: 'gemini-1.5-flash-latest',  // see https://ai.google.dev/gemini-api/docs/models
 *   temperature: 0.1,
 * });
 *
 * const enriched = await llm.enrichTable(rawTable, schemaHash);
 * const sql = await llm.generateSQL('show me top customers', enrichedTables);
 */
export class GeminiLLM extends BaseLLM {
  /**
   * The Google Generative AI client — the top-level SDK entry point.
   * Created once from the API key and reused for all requests.
   */
  private readonly client: GoogleGenerativeAI;

  /**
   * The specific Gemini model instance configured for this LLM.
   * Holds settings like temperature and safety thresholds.
   */
  private readonly model: GenerativeModel;

  /**
   * Creates a GeminiLLM instance.
   *
   * @param config - LLM configuration. `config.model` should be a valid
   *                 Gemini model name (e.g. 'gemini-1.5-flash-latest', 'gemini-2.0-flash').
   *
   * @example
   * const llm = new GeminiLLM({
   *   provider: 'gemini',
   *   apiKey: 'your-api-key',
   *   model: 'gemini-1.5-flash-latest',  // see https://ai.google.dev/gemini-api/docs/models
   * });
   */
  constructor(config: LLMConfig) {
    super(config);

    // Initialise the Google AI client with the user's API key
    this.client = new GoogleGenerativeAI(config.apiKey);

    // Get the specific model instance with our configuration
    this.model = this.client.getGenerativeModel({
      model: config.model,
      generationConfig: {
        // Low temperature = more deterministic, consistent SQL output
        temperature: config.temperature ?? 0.1,
        // We want the full response, not a truncated one
        maxOutputTokens: 4096,
      },
      // Disable safety filters for code/SQL generation.
      // Without this, Gemini might block queries involving "dangerous" SQL keywords.
      safetySettings: [
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        },
      ],
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENRICHMENT
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Calls Gemini to produce a business-friendly description of a database table.
   *
   * This is the core of the "LLM-Generated Business Layer" strategy.
   * The LLM receives the raw technical schema and returns a rich
   * description with business names, synonyms, and example questions —
   * all the things that help bridge the gap between user language
   * and database column names.
   *
   * @param rawTable   - Raw schema data for the table to enrich.
   * @param schemaHash - Hash of the raw schema used for change detection.
   * @returns Fully populated EnrichedTable object.
   * @throws Error if the Gemini API call fails or returns unparseable output.
   */
  async enrichTable(rawTable: RawTable, schemaHash: string): Promise<EnrichedTable> {
    const prompt = this.buildEnrichmentPrompt(rawTable);

    let responseText: string;
    try {
      const result = await this.model.generateContent(prompt);
      responseText = result.response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[nlsql] Gemini API call failed during enrichment of table "${rawTable.tableName}": ${message}`
      );
    }

    let parsed: EnrichmentResponse;
    try {
      parsed = this.extractJSON<EnrichmentResponse>(responseText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[nlsql] Could not parse Gemini enrichment response for table "${rawTable.tableName}". ` +
        `Parse error: ${message}. Raw response: ${responseText.substring(0, 300)}`
      );
    }

    // Validate required fields are present
    this.validateEnrichmentResponse(parsed, rawTable.tableName);

    // Map column enrichments, falling back to safe defaults for any missing fields
    const enrichedColumns = rawTable.columns.map((rawCol) => {
      const found = parsed.columns?.find(
        (c) => c.name?.toLowerCase() === rawCol.columnName.toLowerCase()
      );
      return {
        name: rawCol.columnName,
        businessLabel: found?.businessLabel ?? rawCol.columnName,
        description: found?.description ?? `Column of type ${rawCol.dataType}`,
        synonyms: Array.isArray(found?.synonyms) ? found!.synonyms : [],
        exampleQuestions: Array.isArray(found?.exampleQuestions) ? found!.exampleQuestions : [],
      };
    });

    return {
      tableName: rawTable.tableName,
      businessName: parsed.businessName,
      description: parsed.description,
      useCases: Array.isArray(parsed.useCases) ? parsed.useCases : [],
      synonyms: Array.isArray(parsed.synonyms) ? parsed.synonyms : [],
      columns: enrichedColumns,
      enrichedAt: new Date().toISOString(),
      schemaHash,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SQL GENERATION
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Calls Gemini to generate a MySQL SELECT query from a natural language question.
   *
   * The prompt includes:
   *  1. Role definition and strict rules (SELECT only, no wildcards, etc.)
   *  2. Schema context — enriched descriptions of the most relevant tables
   *  3. Optional few-shot examples to guide the model
   *  4. The user's actual question
   *
   * @param userQuery       - The plain English question from the user.
   * @param contextTables   - Enriched table descriptions to include as context.
   * @param fewShotExamples - Optional worked examples to improve accuracy.
   * @returns Raw SQL string from Gemini (may still contain markdown fences).
   * @throws Error if the API call fails.
   */
  async generateSQL(
    userQuery: string,
    contextTables: EnrichedTable[],
    fewShotExamples: FewShotExample[] = []
  ): Promise<string> {
    const prompt = this.buildSQLGenerationPrompt(userQuery, contextTables, fewShotExamples);

    let responseText: string;
    try {
      const result = await this.model.generateContent(prompt);
      responseText = result.response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[nlsql] Gemini API call failed during SQL generation: ${message}`);
    }

    // Strip markdown fences if present
    return this.extractSQL(responseText);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE: PROMPT BUILDERS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Constructs the enrichment prompt sent to Gemini.
   * The prompt asks Gemini to analyse the raw table schema and produce
   * a structured JSON description in the EnrichmentResponse format.
   *
   * @param rawTable - The table to describe.
   * @returns The full prompt string.
   */
  private buildEnrichmentPrompt(rawTable: RawTable): string {
    // Format columns for the prompt
    const columnList = rawTable.columns
      .map((col) => {
        const parts = [
          `  - ${col.columnName} (${col.dataType}`,
          col.isNullable === 'NO' ? ', NOT NULL' : '',
          col.columnKey === 'PRI' ? ', PRIMARY KEY' : '',
          col.columnKey === 'MUL' ? ', FOREIGN KEY' : '',
          col.extra ? `, ${col.extra}` : '',
          ')',
        ];
        if (col.columnComment) parts.push(` -- ${col.columnComment}`);
        if (col.sampleValues) parts.push(` [sample values: ${col.sampleValues}]`);
        return parts.join('');
      })
      .join('\n');

    // Format foreign keys for the prompt
    const fkSection = rawTable.foreignKeys.length > 0
      ? `\nForeign Keys:\n${rawTable.foreignKeys.map(
          (fk) => `  - ${fk.columnName} references ${fk.referencedTable}.${fk.referencedColumn}`
        ).join('\n')}`
      : '';

    return `You are a database documentation expert. Your task is to create clear,
business-friendly documentation for a MySQL database table.

Given the following table definition, produce a JSON object that describes
the table in plain English — as a business analyst or end user would understand it.

TABLE DEFINITION:
Table name: ${rawTable.tableName}
${rawTable.tableComment ? `Table comment: ${rawTable.tableComment}` : ''}
Approximate row count: ${rawTable.tableRows.toLocaleString()}
Columns:
${columnList}${fkSection}

INSTRUCTIONS:
- Write descriptions for non-technical business users, not developers.
- businessName should be 2–4 words (e.g. "Customer Orders", "Product Inventory").
- description should be 1–3 sentences explaining what this table represents.
- useCases should be 3–5 real questions a manager or analyst might ask.
- synonyms are alternative names users might use for this table.
- For each column, write a businessLabel and description a non-technical user would understand.
- Include synonyms for column names (the other words users might use).
- Include 1–2 example natural language questions per column.

RESPOND WITH ONLY VALID JSON. No explanation, no markdown, just the JSON object.

{
  "businessName": "string",
  "description": "string",
  "useCases": ["string"],
  "synonyms": ["string"],
  "columns": [
    {
      "name": "exact_column_name_from_schema",
      "businessLabel": "string",
      "description": "string",
      "synonyms": ["string"],
      "exampleQuestions": ["string"]
    }
  ]
}`;
  }

  /**
   * Constructs the SQL generation prompt sent to Gemini.
   * This is the most important prompt in the library — it directly
   * determines the quality of the generated SQL.
   *
   * @param userQuery       - The user's natural language question.
   * @param contextTables   - Relevant enriched table descriptions.
   * @param fewShotExamples - Worked examples to guide the model.
   * @returns The full prompt string.
   */
  private buildSQLGenerationPrompt(
    userQuery: string,
    contextTables: EnrichedTable[],
    fewShotExamples: FewShotExample[]
  ): string {
    const schemaContext = this.buildSchemaContext(contextTables);
    const fewShotBlock = this.buildFewShotBlock(fewShotExamples);

    return `You are an expert MySQL query generator. Your ONLY job is to convert a
user's natural language question into a valid MySQL SELECT query.

════════════════════════════════════════════════════════
HARD RULES — you must ALWAYS follow these:
════════════════════════════════════════════════════════
1. Output ONLY the SQL query. No explanation. No markdown fences.
2. ONLY write SELECT statements. NEVER write INSERT, UPDATE, DELETE,
   DROP, ALTER, CREATE, or any other statement.
3. Always use table_name.column_name notation (e.g. orders.status).
4. Never use SELECT *. Always list specific column names.
5. Only use table and column names from the schema provided below.
6. Use MySQL syntax: NOW(), DATE_SUB(), DATE_FORMAT(), IFNULL(), etc.
7. Unless the user asks for a count or total, add LIMIT 1000 at the end.
8. If the question cannot be answered using the available schema, return:
   -- UNABLE_TO_ANSWER: <brief reason>

════════════════════════════════════════════════════════
AVAILABLE DATABASE SCHEMA:
════════════════════════════════════════════════════════
${schemaContext}

${fewShotBlock ? `════════════════════════════════════════════════════════\n${fewShotBlock}\n` : ''}
════════════════════════════════════════════════════════
USER QUESTION: ${userQuery}
════════════════════════════════════════════════════════
SQL:`;
  }

  /**
   * Validates that the enrichment response from Gemini has all required fields.
   * Throws a descriptive error if critical fields are missing.
   *
   * @param parsed    - The parsed JSON response from Gemini.
   * @param tableName - Used in error messages.
   * @throws Error if required fields are missing.
   */
  private validateEnrichmentResponse(parsed: unknown, tableName: string): void {
    const obj = parsed as Record<string, unknown>;
    const required: (keyof EnrichmentResponse)[] = ['businessName', 'description', 'columns'];

    for (const field of required) {
      if (!obj[field]) {
        throw new Error(
          `[nlsql] Gemini enrichment response for table "${tableName}" is missing required field: "${field}"`
        );
      }
    }
  }
}
