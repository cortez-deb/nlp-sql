/**
 * types/index.ts
 *
 * This file defines the shared "shapes" (interfaces and types) used
 * throughout the nlsql library. Think of these as contracts — every
 * class and function agrees to speak the same language by referencing
 * these types.
 */

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE CONNECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything needed to open a connection to a MySQL database.
 *
 * @example
 * const config: MySQLConnectionConfig = {
 *   host: 'localhost',
 *   port: 3306,
 *   user: 'my_user',
 *   password: 'my_password',
 *   database: 'my_database',
 * };
 */
export interface MySQLConnectionConfig {
  /** Hostname or IP address of the MySQL server. Defaults to 'localhost'. */
  host: string;

  /** Port the MySQL server is listening on. Defaults to 3306. */
  port?: number;

  /** MySQL username. */
  user: string;

  /** MySQL password. */
  password: string;

  /** The name of the database to connect to. */
  database: string;

  /**
   * Optional: Maximum number of simultaneous connections in the pool.
   * A pool reuses connections instead of creating a new one for every query.
   * Defaults to 5.
   */
  connectionLimit?: number;

  /**
   * Optional: Connection timeout in milliseconds.
   * If the database doesn't respond within this time, an error is thrown.
   * Defaults to 10000 (10 seconds).
   */
  connectTimeout?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM (LARGE LANGUAGE MODEL) CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported LLM providers.
 *  - 'gemini'  → Google Gemini (requires API key from https://aistudio.google.com)
 *  - 'openai'  → OpenAI GPT models (requires API key from https://platform.openai.com)
 *  - 'ollama'  → Local models via Ollama (no API key needed, runs on your machine)
 */
export type LLMProvider = 'gemini' | 'openai' | 'ollama';

/**
 * Configuration for the LLM (AI model) used to understand natural language
 * and generate SQL queries.
 *
 * @example
 * const llmConfig: LLMConfig = {
 *   provider: 'gemini',
 *   apiKey: process.env.GEMINI_API_KEY!,
 *   model: 'gemini-1.5-flash-latest',
 * };
 */
export interface LLMConfig {
  /** Which AI provider to use: 'gemini', 'openai', or 'ollama'. */
  provider: LLMProvider;

  /**
   * Your API key for the chosen provider.
   * Not required for Ollama (local models) — pass an empty string.
   * Best practice: load this from an environment variable, never hardcode it.
   */
  apiKey: string;

  /**
   * The specific model name to use.
   *
   * Gemini options:
   *   - 'gemini-1.5-flash-latest'  → Fast, cost-effective, good for most queries
   *   - 'gemini-1.5-pro-latest'   → Higher quality, slower, better for complex schemas
   *   - 'gemini-2.0-flash'        → Latest generation, or 'gemini-2.0-flash-lite' for cheapest
   */
  model: string;

  /**
   * Optional: Base URL override for the LLM API endpoint.
   *
   * - Ollama: defaults to 'http://localhost:11434'. Change this if Ollama
   *   is running on a different host or port (e.g. a remote GPU machine).
   * - OpenAI: use any OpenAI-compatible API
   *   (e.g. Azure OpenAI, Together AI, Groq).
   * - Gemini: not used.
   *
   * @example
   * baseURL: 'http://192.168.1.100:11434'  // Ollama on a remote machine
   * baseURL: 'https://my-proxy.example.com/v1'  // OpenAI-compatible proxy
   */
  baseURL?: string;

  /**
   * Optional: Controls how "creative" the LLM's responses are.
   * - 0.0 = very deterministic (same input → same output, best for SQL)
   * - 1.0 = very creative/random (bad for SQL generation)
   * Defaults to 0.1 for predictable SQL output.
   */
  temperature?: number;
  /**
   * The database dialect to use for generating SQL.
   * Defaults to 'mysql'.
   */
  databaseDialect?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA & ENRICHMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw information about a single column, as read directly from MySQL's
 * INFORMATION_SCHEMA system tables.
 */
export interface RawColumn {
  /** The column's technical name (e.g. "cust_acq_dt"). */
  columnName: string;

  /** MySQL data type (e.g. "int", "varchar", "datetime", "decimal"). */
  dataType: string;

  /** Whether this column can contain NULL values. "YES" or "NO". */
  isNullable: string;

  /** The column's position in the table (1-based). */
  ordinalPosition: number;

  /** Default value if any, or null. */
  columnDefault: string | null;

  /** Additional flags like "auto_increment". */
  extra: string;

  /** Whether this column is a primary key, unique key, or regular. */
  columnKey: string;

  /** Human-written comment on the column, if any was added in MySQL. */
  columnComment: string;

  /**
   * A comma-separated list of sample values from the actual data.
   * These help the LLM understand what kind of data lives in this column.
   * Example: "pending, shipped, delivered, cancelled"
   */
  sampleValues?: string;
}

/**
 * Raw information about a single database table, as read from INFORMATION_SCHEMA.
 */
export interface RawTable {
  /** The table's technical name (e.g. "cust_master"). */
  tableName: string;

  /** Human-written comment on the table, if any was added in MySQL. */
  tableComment: string;

  /** Approximate number of rows in the table. */
  tableRows: number;

  /** All columns that belong to this table. */
  columns: RawColumn[];

  /**
   * Foreign key relationships: which columns in this table
   * reference columns in other tables.
   */
  foreignKeys: ForeignKeyInfo[];
}

/**
 * Describes a foreign key relationship between two tables.
 * Example: orders.customer_id → customers.id
 */
export interface ForeignKeyInfo {
  /** The column in this table that holds the foreign key. */
  columnName: string;

  /** The table being referenced. */
  referencedTable: string;

  /** The column in the referenced table (usually its primary key). */
  referencedColumn: string;
}

/**
 * An LLM-enriched description of a single column.
 * This is the business-friendly version of RawColumn.
 */
export interface EnrichedColumn {
  /** Original technical column name. */
  name: string;

  /** Plain English label a business user would use (e.g. "Customer Sign-up Date"). */
  businessLabel: string;

  /** Clear explanation of what this column means in business terms. */
  description: string;

  /**
   * Alternative words a user might use when asking about this column.
   * Example: ["sign up date", "registration date", "join date", "when they joined"]
   */
  synonyms: string[];

  /**
   * Example natural language questions that would involve this column.
   * Used to help the LLM understand how users think about this data.
   */
  exampleQuestions: string[];
}

/**
 * An LLM-enriched description of a single database table.
 * This is the business-friendly version of RawTable, stored in the
 * nlsql_enriched_schema MySQL table between runs.
 */
export interface EnrichedTable {
  /** Original technical table name. */
  tableName: string;

  /** Plain English name for this table (e.g. "Customer Orders"). */
  businessName: string;

  /**
   * A paragraph describing what this table represents in business terms.
   * Written for a non-technical audience.
   */
  description: string;

  /**
   * Example questions a business user might ask that relate to this table.
   * Example: ["How many orders were placed last month?", "Who are my top customers?"]
   */
  useCases: string[];

  /**
   * Alternative names users might use for this table.
   * Example: ["purchases", "transactions", "sales"]
   */
  synonyms: string[];

  /** Enriched descriptions of each column in the table. */
  columns: EnrichedColumn[];

  /** ISO 8601 timestamp of when this enrichment was generated. */
  enrichedAt: string;

  /**
   * Hash of the raw schema at enrichment time.
   * Used to detect when the schema has changed and re-enrichment is needed.
   */
  schemaHash: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single few-shot example: a natural language question paired with
 * the correct SQL query. These are shown to the LLM to help it understand
 * the pattern it should follow.
 *
 * @example
 * {
 *   question: "How many customers signed up last month?",
 *   sql: "SELECT COUNT(*) AS count FROM customers WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)"
 * }
 */
export interface FewShotExample {
  /** A natural language question. */
  question: string;

  /** The correct SQL query that answers that question. */
  sql: string;
}

/**
 * The result returned by the NLSQLClient.query() method.
 *
 * Always check the `error` field first. If it is not null, the query failed
 * and `results` will be null.
 */
export interface QueryResult {
  /**
   * The SQL query that was generated by the LLM and executed.
   * Always inspect this for debugging — it shows exactly what ran.
   */
  sql: string | null;

  /**
   * The rows returned by the SQL query.
   * Each row is an object where keys are column names and values are cell values.
   * Null if the query failed validation or execution.
   */
  results: Record<string, unknown>[] | null;

  /**
   * If something went wrong, this describes what happened.
   * Null when the query succeeded.
   */
  error: string | null;

  /**
   * Breakdown of how long each step took, in milliseconds.
   * Useful for identifying performance bottlenecks.
   */
  timing: {
    /** Time to retrieve relevant schema context. */
    retrievalMs: number;

    /** Time for the LLM to generate the SQL. */
    generationMs: number;

    /** Time to validate the generated SQL. */
    validationMs: number;

    /** Time to execute the SQL against the database. */
    executionMs: number;

    /** Total end-to-end time. */
    totalMs: number;
  };
}

/**
 * Options that control how the NLSQLClient generates queries.
 * All fields are optional — sensible defaults are used when omitted.
 */
export interface QueryOptions {
  /**
   * Custom few-shot examples to include in the LLM prompt.
   * The more relevant these are to your schema and users' questions,
   * the better the generated SQL will be.
   */
  fewShotExamples?: FewShotExample[];

  /**
   * Maximum number of rows to return.
   * Protects against accidentally loading millions of rows into memory.
   * Defaults to 1000.
   */
  maxRows?: number;

  /**
   * Maximum number of enriched table descriptions to include in the
   * LLM prompt for context. Higher = more context but more tokens used.
   * Defaults to 5.
   */
  maxContextTables?: number;
  /**
   * The database dialect to use for generating SQL.
   * This is passed to the LLM so it can use the correct syntax.
   * Defaults to 'mysql'.
   */
  databaseDialect?: string;
}

/**
 * Options for the enrichment process.
 */
export interface EnrichmentOptions {
  /**
   * If true, re-enrich all tables even if they haven't changed.
   * Useful after updating the LLM or improving the enrichment prompt.
   * Defaults to false.
   */
  forceRefresh?: boolean;

  /**
   * Specific table names to enrich. If omitted, all tables are enriched.
   * Useful for large databases where you only want to expose certain tables.
   */
  tables?: string[];

  /**
   * Number of sample values to collect per column to help the LLM
   * understand the data. Defaults to 5.
   */
  sampleSize?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The result of validating a SQL query before execution.
 */
export interface ValidationResult {
  /** True if the query is safe to execute. False if it should be rejected. */
  isValid: boolean;

  /**
   * If isValid is false, this explains why the query was rejected.
   * Examples: "Blocked keyword detected: DROP", "Only SELECT statements are allowed"
   */
  reason: string | null;
}
