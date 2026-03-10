/**
 * llm/OllamaLLM.ts
 *
 * Concrete implementation of BaseLLM using Ollama — a tool for running
 * large language models locally on your own machine.
 *
 * Ollama runs a local HTTP server (default: http://localhost:11434) that
 * exposes an OpenAI-compatible API. This means no API keys, no usage costs,
 * and your data never leaves your machine — ideal for local development
 * or privacy-sensitive deployments.
 *
 * Getting started with Ollama:
 *  1. Install from https://ollama.com
 *  2. Run a model: `ollama pull llama3.1` (or any model below)
 *  3. Start the server: `ollama serve`  (usually starts automatically)
 *  4. Point nlsql at it: provider: 'ollama', model: 'llama3.1'
 *
 * Ollama API reference: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

import { BaseLLM } from './BaseLLM';
import type { LLMConfig, EnrichedTable, RawTable, FewShotExample } from '../types';

/**
 * Ollama-specific configuration, extending the base LLMConfig.
 * The apiKey field is not used for Ollama (no key needed for local models),
 * but is kept in the interface for consistency — just pass an empty string.
 */
export interface OllamaConfig extends LLMConfig {
  provider: 'ollama';

  /**
   * The base URL of your Ollama server.
   * Defaults to 'http://localhost:11434' if not specified.
   *
   * Change this if you're running Ollama on a different host or port,
   * for example on a remote GPU machine in your network.
   *
   * @default 'http://localhost:11434'
   */
  baseURL?: string;
}

/**
 * Shape of a message in Ollama's chat API (same format as OpenAI).
 */
interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Shape of the request body sent to POST /api/chat.
 */
interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: false;           // Always false — we want the full response at once
  options: {
    temperature: number;
    num_predict: number;   // Ollama's equivalent of max_tokens
  };
  format?: 'json';         // When set, Ollama forces valid JSON output
}

/**
 * Relevant part of Ollama's /api/chat response.
 */
interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
  };
  done: boolean;
  error?: string;
}

/**
 * Internal shape of the JSON we ask Ollama to return for table enrichment.
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
 * OllamaLLM uses locally-running Ollama models to power nlsql.
 * No API key or internet connection required — everything runs on your machine.
 *
 * Recommended models for SQL generation (pull with `ollama pull <model>`):
 *  - 'llama3.1'          → Meta's Llama 3.1, excellent all-rounder (8B or 70B)
 *  - 'llama3.2'          → Newer, lighter Llama model (1B or 3B — very fast)
 *  - 'mistral'           → Mistral 7B, good at structured output and SQL
 *  - 'codellama'         → Meta's code-focused model, strong at SQL generation
 *  - 'deepseek-coder'    → Excellent at code and SQL tasks
 *  - 'qwen2.5-coder'     → Alibaba's code model, strong SQL performance
 *  - 'phi3'              → Microsoft's small model, fast on CPU
 *
 * See all available models at: https://ollama.com/library
 *
 * @example
 * // Make sure Ollama is running: `ollama serve`
 * // And you've pulled your model: `ollama pull llama3.1`
 *
 * const client = new NLSQLClient({
 *   db: { host: 'localhost', user: 'root', password: '', database: 'shop' },
 *   llm: {
 *     provider: 'ollama',
 *     apiKey: '',           // Not needed for Ollama — leave empty
 *     model: 'llama3.1',    // Must match a model you've pulled
 *     baseURL: 'http://localhost:11434',  // Optional, this is the default
 *   },
 * });
 */
export class OllamaLLM extends BaseLLM {
  /**
   * Base URL of the Ollama server.
   * Defaults to the standard local address.
   */
  private readonly baseURL: string;

  /**
   * Creates a new OllamaLLM instance.
   *
   * @param config - LLM config with provider: 'ollama'.
   *                 Set baseURL if Ollama is not on localhost:11434.
   */
  constructor(config: LLMConfig) {
    super(config);
    this.baseURL = config.baseURL?.replace(/\/$/, '') ?? 'http://localhost:11434';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENRICHMENT
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Calls a local Ollama model to produce a business-friendly description
   * of a database table.
   *
   * Uses Ollama's JSON format mode (format: 'json') to improve the chances
   * of receiving valid JSON. Note: not all models support this equally well.
   * If you get JSON parse errors, try a different model (codellama or mistral
   * tend to produce cleaner structured output).
   *
   * @param rawTable   - Raw schema data for the table to enrich.
   * @param schemaHash - Hash of the raw schema for change detection.
   * @returns A fully populated EnrichedTable object.
   * @throws Error if the Ollama call fails or returns unparseable output.
   */
  async enrichTable(rawTable: RawTable, schemaHash: string): Promise<EnrichedTable> {
    const userPrompt = this.buildEnrichmentPrompt(rawTable);

    const responseText = await this.callAPI(
      [
        {
          role: 'system',
          content:
            'You are a database documentation expert. ' +
            'You MUST respond with valid JSON only. No explanation, no markdown, no code fences. ' +
            'Output only the JSON object as specified by the user.',
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
        `[nlsql] Could not parse Ollama enrichment response for table "${rawTable.tableName}". ` +
        `This often means the model didn't follow JSON format. Try a different model ` +
        `(e.g. mistral, codellama, deepseek-coder). ` +
        `Parse error: ${message}. Raw response (first 300 chars): ${responseText.substring(0, 300)}`
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
   * Calls a local Ollama model to generate a MySQL SELECT query from a
   * natural language question.
   *
   * Ollama models vary in their ability to follow strict instructions.
   * Code-focused models (codellama, deepseek-coder, qwen2.5-coder) tend to
   * produce cleaner SQL with fewer explanatory comments.
   *
   * @param userQuery       - The plain English question from the user.
   * @param contextTables   - Enriched table descriptions to include as context.
   * @param fewShotExamples - Optional worked examples to improve accuracy.
   * @returns Raw SQL string from the model.
   * @throws Error if the Ollama call fails.
   */
  async generateSQL(
    userQuery: string,
    contextTables: EnrichedTable[],
    fewShotExamples: FewShotExample[] = []
  ): Promise<string> {
    const schemaContext = this.buildSchemaContext(contextTables);
    const fewShotBlock  = this.buildFewShotBlock(fewShotExamples);

    const messages: OllamaMessage[] = [
      {
        role: 'system',
        content: `You are an expert MySQL query generator.
Your ONLY output must be a single valid MySQL SELECT query — nothing else.

RULES (follow these strictly):
1. Output ONLY the SQL. No explanation. No markdown. No code fences. No comments.
2. ONLY write SELECT statements. NEVER write INSERT, UPDATE, DELETE, DROP, ALTER, CREATE.
3. Always prefix column names with their table name: table_name.column_name.
4. Never use SELECT *. Always name specific columns.
5. Use only table and column names from the schema provided.
6. Use MySQL syntax: NOW(), DATE_SUB(), DATE_FORMAT(), IFNULL(), COALESCE().
7. Add LIMIT 1000 unless the user asks for a count or sum.
8. If you cannot answer with the available schema, output exactly:
   -- UNABLE_TO_ANSWER: <reason>`,
      },
    ];

    // Add few-shot examples as conversation turns for better instruction following
    for (const ex of fewShotExamples) {
      messages.push({ role: 'user',      content: ex.question });
      messages.push({ role: 'assistant', content: ex.sql });
    }

    messages.push({
      role: 'user',
      content: `SCHEMA:\n${schemaContext}\n\n${fewShotBlock ? fewShotBlock + '\n\n' : ''}QUESTION: ${userQuery}`,
    });

    const rawSQL = await this.callAPI(messages);
    return this.extractSQL(rawSQL);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sends a chat request to the local Ollama server and returns the response text.
   *
   * Uses the /api/chat endpoint with stream: false so we get the full
   * response in a single HTTP call rather than a streaming response.
   *
   * @param messages - Chat messages to send.
   * @param options  - jsonMode: true tells Ollama to enforce JSON output format.
   * @returns The response content string.
   * @throws Error if the server is unreachable or returns an error.
   */
  private async callAPI(
    messages: OllamaMessage[],
    options: { jsonMode?: boolean } = {}
  ): Promise<string> {
    const body: OllamaChatRequest = {
      model: this.config.model,
      messages,
      stream: false,  // Get the full response in one shot, not a stream
      options: {
        temperature: this.config.temperature ?? 0.1,
        num_predict: 4096,
      },
    };

    // Ollama's JSON format mode — instructs the model to produce valid JSON.
    // Supported by most models but quality varies.
    if (options.jsonMode) {
      body.format = 'json';
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Provide a helpful error for the most common case: Ollama isn't running
      throw new Error(
        `[nlsql] Could not connect to Ollama at ${this.baseURL}. ` +
        `Is Ollama running? Try: ollama serve\n` +
        `Original error: ${message}`
      );
    }

    const data = await response.json() as OllamaChatResponse;

    if (!response.ok || data.error) {
      const reason = data.error ?? `HTTP ${response.status}`;
      // Provide helpful guidance for common errors
      if (response.status === 404) {
        throw new Error(
          `[nlsql] Ollama model "${this.config.model}" not found. ` +
          `Pull it first: ollama pull ${this.config.model}`
        );
      }
      throw new Error(`[nlsql] Ollama API error: ${reason}`);
    }

    const content = data.message?.content;
    if (!content) {
      throw new Error('[nlsql] Ollama returned an empty response.');
    }

    return content;
  }

  /**
   * Constructs the enrichment prompt.
   * Same structure as OpenAI/Gemini for consistency.
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

    return `Describe the following MySQL table for a non-technical business user.

TABLE DEFINITION:
Table name: ${rawTable.tableName}
${rawTable.tableComment ? `Table comment: ${rawTable.tableComment}` : ''}
Approximate rows: ${rawTable.tableRows.toLocaleString()}
Columns:
${columnList}${fkSection}

Output ONLY this JSON object (no extra text):
{
  "businessName": "2-4 word plain English name",
  "description": "1-3 sentences what this table is",
  "useCases": ["question a manager might ask", "..."],
  "synonyms": ["other name for this table", "..."],
  "columns": [
    {
      "name": "exact_column_name_from_above",
      "businessLabel": "plain English label",
      "description": "what this column means",
      "synonyms": ["other words users might use"],
      "exampleQuestions": ["natural language question involving this column"]
    }
  ]
}`;
  }

  /**
   * Validates required fields on an enrichment response.
   * @throws Error if required fields are missing.
   */
  private validateEnrichmentResponse(parsed: unknown, tableName: string): void {
    const obj = parsed as Record<string, unknown>;
    const required = ['businessName', 'description', 'columns'] as const;
    for (const field of required) {
      if (!obj[field]) {
        throw new Error(
          `[nlsql] Ollama enrichment response for table "${tableName}" is missing field: "${field}". ` +
          `Consider using a more capable model (e.g. llama3.1, mistral, codellama).`
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Checks whether the Ollama server is reachable and the configured model
   * is available. Call this before initialise() for a better error message.
   *
   * @returns Object with { running, modelAvailable, availableModels }
   *
   * @example
   * const status = await OllamaLLM.checkServer('http://localhost:11434', 'llama3.1');
   * if (!status.running) {
   *   console.error('Ollama is not running. Start it with: ollama serve');
   * } else if (!status.modelAvailable) {
   *   console.error(`Model not found. Pull it: ollama pull llama3.1`);
   *   console.log('Available models:', status.availableModels);
   * }
   */
  static async checkServer(
    baseURL = 'http://localhost:11434',
    model?: string
  ): Promise<{ running: boolean; modelAvailable: boolean; availableModels: string[] }> {
    try {
      const response = await fetch(`${baseURL}/api/tags`);
      if (!response.ok) {
        return { running: false, modelAvailable: false, availableModels: [] };
      }

      const data = await response.json() as { models: Array<{ name: string }> };
      const availableModels = (data.models ?? []).map((m) => m.name);
      const modelAvailable = model
        ? availableModels.some((m) => m === model || m.startsWith(`${model}:`))
        : true;

      return { running: true, modelAvailable, availableModels };
    } catch {
      return { running: false, modelAvailable: false, availableModels: [] };
    }
  }
}
