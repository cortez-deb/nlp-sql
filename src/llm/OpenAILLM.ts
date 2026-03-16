/**
 * llm/OpenAILLM.ts
 *
 * Concrete implementation of BaseLLM using the OpenAI API.
 * Works with any OpenAI-compatible model: GPT-4o, GPT-4o-mini, GPT-4-turbo, etc.
 *
 * This implementation uses the OpenAI REST API directly via fetch() rather than
 * the openai npm SDK, so it has zero additional dependencies.
 *
 * OpenAI API reference: https://platform.openai.com/docs/api-reference/chat
 */

import { BaseLLM } from './BaseLLM';
import type { LLMConfig, EnrichedTable, RawTable, FewShotExample } from '../types';

/**
 * Shape of a single message in the OpenAI chat completions format.
 * OpenAI uses a conversation-style API where each message has a role.
 */
interface OpenAIMessage {
  /** 'system' = background instructions, 'user' = the prompt, 'assistant' = AI reply */
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Shape of the JSON body sent to POST /v1/chat/completions.
 */
interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature: number;
  max_tokens: number;
  /** Ask OpenAI to return only plain text, not markdown or code fences */
  response_format?: { type: 'text' | 'json_object' };
}

/**
 * The relevant part of the JSON response from OpenAI's chat completions endpoint.
 */
interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
    finish_reason: string;
  }>;
  error?: {
    message: string;
    type: string;
    code: string;
  };
}

/**
 * Internal shape of the JSON we ask OpenAI to return for table enrichment.
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
 * OpenAILLM integrates with OpenAI's chat completions API to power nlsql.
 *
 * Supported models (check https://platform.openai.com/docs/models for latest):
 *  - 'gpt-4o'          → Best quality, multimodal, recommended for complex schemas
 *  - 'gpt-4o-mini'     → Fast and cheap, great for most use cases
 *  - 'gpt-4-turbo'     → Previous generation high-quality model
 *  - 'gpt-3.5-turbo'   → Legacy fast/cheap option
 *
 * ⚠️  You need an OpenAI API key from https://platform.openai.com/api-keys
 *
 * @example
 * const client = new NLSQLClient({
 *   db: { ... },
 *   llm: {
 *     provider: 'openai',
 *     apiKey: process.env.OPENAI_API_KEY!,
 *     model: 'gpt-4o-mini',  // fast and affordable
 *   },
 * });
 */
export class OpenAILLM extends BaseLLM {
  /**
   * Base URL for OpenAI's API.
   * Can be overridden via config.baseURL to use OpenAI-compatible providers
   * (e.g. Azure OpenAI, Together AI, Groq).
   */
  private readonly baseURL: string;

  /**
   * Creates a new OpenAILLM instance.
   *
   * @param config - LLM configuration. Set provider to 'openai' and supply
   *                 your OpenAI API key and desired model name.
   */
  constructor(config: LLMConfig) {
    super(config);
    // Allow a custom base URL for OpenAI-compatible providers.
    // If not specified, use the standard OpenAI endpoint.
    this.baseURL = config.baseURL ?? 'https://api.openai.com/v1';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENRICHMENT
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Calls OpenAI to produce a business-friendly description of a database table.
   * Uses GPT's JSON mode when available (gpt-4o, gpt-4o-mini, gpt-4-turbo)
   * to guarantee well-formed JSON output.
   *
   * @param rawTable   - Raw schema data for the table to enrich.
   * @param schemaHash - Hash of the raw schema for change detection.
   * @returns A fully populated EnrichedTable object.
   * @throws Error if the API call fails or returns unparseable output.
   */
  async enrichTable(rawTable: RawTable, schemaHash: string): Promise<EnrichedTable> {
    const userPrompt = this.buildEnrichmentPrompt(rawTable);

    // Use JSON mode so OpenAI guarantees valid JSON output.
    // json_object mode is supported on gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo-1106+
    const responseText = await this.callAPI(
      [
        {
          role: 'system',
          content:
            'You are a database documentation expert. ' +
            'You always respond with valid JSON only — no explanation, no markdown, no code fences.',
        },
        { role: 'user', content: userPrompt },
      ],
      { jsonMode: true }
    );

    let parsed: EnrichmentResponse;
    try {
      parsed = this.extractJSON<EnrichmentResponse>(responseText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[nlsql] Could not parse OpenAI enrichment response for table "${rawTable.tableName}". ` +
        `Parse error: ${message}. Raw response: ${responseText.substring(0, 300)}`
      );
    }

    this.validateEnrichmentResponse(parsed, rawTable.tableName);

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
   * Calls OpenAI to generate a MySQL SELECT query from a natural language question.
   *
   * Uses a system prompt to set strict rules (SELECT only, specific columns, etc.)
   * and a user prompt containing the schema context and the question.
   *
   * @param userQuery       - The plain English question from the user.
   * @param contextTables   - Enriched table descriptions to include as context.
   * @param fewShotExamples - Optional worked examples to improve accuracy.
   * @returns Raw SQL string from OpenAI.
   * @throws Error if the API call fails.
   */
  async generateSQL(
    userQuery: string,
    contextTables: EnrichedTable[],
    fewShotExamples: FewShotExample[] = [],
    databaseDialect: string = 'mysql'
  ): Promise<string> {
    const schemaContext = this.buildSchemaContext(contextTables);
    const fewShotBlock = this.buildFewShotBlock(fewShotExamples);

    const messages: OpenAIMessage[] = [
      {
        role: 'system',
        content: `You are an expert ${databaseDialect} query generator.
Your ONLY job is to convert the user's natural language question into a valid ${databaseDialect} SELECT query.

HARD RULES — always follow these without exception:
1. Output ONLY the SQL query. No explanation. No markdown. No code fences.
2. ONLY write SELECT statements. NEVER write INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, or any other statement.
3. Always use table_name.column_name notation (e.g. orders.status).
4. Never use SELECT *. Always list specific column names.
5. Only use table and column names from the schema provided by the user.
6. Use ${databaseDialect} syntax: NOW(), DATE_SUB(), DATE_FORMAT(), IFNULL(), etc.
7. Unless the user asks for a count or total, add LIMIT 1000 at the end.
8. If the question cannot be answered with the available schema, respond with exactly:
   -- UNABLE_TO_ANSWER: <brief reason>`,
      },
    ];

    // Add few-shot examples as alternating user/assistant turns.
    // This is more effective with OpenAI than injecting examples into a single prompt.
    for (const ex of fewShotExamples) {
      messages.push({ role: 'user',      content: ex.question });
      messages.push({ role: 'assistant', content: ex.sql });
    }

    // Final user message: schema context + the actual question
    messages.push({
      role: 'user',
      content: `DATABASE SCHEMA:\n${schemaContext}\n\n${fewShotBlock ? fewShotBlock + '\n\n' : ''}QUESTION: ${userQuery}`,
    });

    const rawSQL = await this.callAPI(messages);
    return this.extractSQL(rawSQL);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sends a chat completions request to OpenAI and returns the response text.
   *
   * This is the single place all HTTP communication with OpenAI happens.
   * Using fetch() directly avoids a dependency on the openai npm package.
   *
   * @param messages  - Array of chat messages (system + user + optional assistant turns).
   * @param options   - Optional flags (e.g. jsonMode for guaranteed JSON output).
   * @returns The text content of the first choice in the response.
   * @throws Error if the HTTP request fails or OpenAI returns an error.
   */
  private async callAPI(
    messages: OpenAIMessage[],
    options: { jsonMode?: boolean } = {}
  ): Promise<string> {
    const body: OpenAIRequest = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature ?? 0.1,
      max_tokens: 4096,
    };

    // JSON mode tells OpenAI to always return valid JSON.
    // Only enable when we actually need JSON (enrichment), not for SQL generation.
    if (options.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[nlsql] OpenAI API network error: ${message}`);
    }

    const data = await response.json() as OpenAIResponse;

    // OpenAI returns HTTP 200 even for some errors, so check the error field too
    if (!response.ok || data.error) {
      const reason = data.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`[nlsql] OpenAI API error: ${reason}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('[nlsql] OpenAI returned an empty response.');
    }

    return content;
  }

  /**
   * Constructs the enrichment prompt sent to OpenAI.
   * Identical structure to the Gemini enrichment prompt.
   *
   * @param rawTable - The table to describe.
   * @returns The full user prompt string.
   */
  private buildEnrichmentPrompt(rawTable: RawTable): string {
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
        if (col.sampleValues)  parts.push(` [sample values: ${col.sampleValues}]`);
        return parts.join('');
      })
      .join('\n');

    const fkSection = rawTable.foreignKeys.length > 0
      ? `\nForeign Keys:\n${rawTable.foreignKeys.map(
          (fk) => `  - ${fk.columnName} references ${fk.referencedTable}.${fk.referencedColumn}`
        ).join('\n')}`
      : '';

    return `Given the following MySQL table definition, produce a JSON object that describes
the table in plain English — as a business analyst or end user would understand it.

TABLE DEFINITION:
Table name: ${rawTable.tableName}
${rawTable.tableComment ? `Table comment: ${rawTable.tableComment}` : ''}
Approximate row count: ${rawTable.tableRows.toLocaleString()}
Columns:
${columnList}${fkSection}

INSTRUCTIONS:
- Write for non-technical business users, not developers.
- businessName: 2–4 plain English words (e.g. "Customer Orders").
- description: 1–3 sentences explaining what this table represents.
- useCases: 3–5 example questions a manager might ask about this table.
- synonyms: alternative names a user might call this table.
- For each column: a businessLabel and plain English description.
- Include synonyms for columns (alternative words users might use).
- Include 1–2 example natural language questions per column.

Return ONLY this JSON structure (no extra text, no code fences):
{
  "businessName": "string",
  "description": "string",
  "useCases": ["string"],
  "synonyms": ["string"],
  "columns": [
    {
      "name": "exact_column_name",
      "businessLabel": "string",
      "description": "string",
      "synonyms": ["string"],
      "exampleQuestions": ["string"]
    }
  ]
}`;
  }

  /**
   * Validates required fields on an enrichment response from OpenAI.
   * @throws Error if required fields are missing.
   */
  private validateEnrichmentResponse(parsed: unknown, tableName: string): void {
    const obj = parsed as Record<string, unknown>;
    const required = ['businessName', 'description', 'columns'] as const;
    for (const field of required) {
      if (!obj[field]) {
        throw new Error(
          `[nlsql] OpenAI enrichment response for table "${tableName}" is missing field: "${field}"`
        );
      }
    }
  }
}
