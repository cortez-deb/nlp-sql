# nlsql

**Natural Language to SQL** — Ask questions in plain English, get database results back.

`nlsql` connects to your MySQL database, uses Google Gemini via LangChain to understand your schema and the user's question, generates AST-validated read-only SQL queries with automatic retries and summarization, and returns structured results.

---

## How it works

```
User question → [Retrieve schema context] → [LLM generates SQL]
              → [AST Validate: SELECT only] → [Execute with timeout] → [Summarize] → Results
```

The **enrichment pipeline** (run once at setup) uses LLM to translate your technical schema into business-friendly descriptions, stored by default in a local file (`./.nlsql/enrichment.json`). This powers accurate natural language matching at query time.

---

## Installation

```bash
npm install nlsql
```

---

## Quick Start

Set environment variables:
- `DB_HOST` (default `localhost`)
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (e.g., `gemini-2.0-flash`)

```typescript
import { NLSQLClient } from 'nlsql';

const client = new NLSQLClient({
  db: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME!,
  },
  llm: {
    provider: 'gemini',
    apiKey: process.env.GEMINI_API_KEY!,
    model: process.env.GEMINI_MODEL!,
  },
  storage: {
    type: 'file',
    path: './.nlsql/enrichment.json',
  },
});

// Setup & enrichment (run once or skip if stored enrichment is fresh)
await client.initialise({ forceRefresh: false }, (p) => {
  console.log(`Enriching ${p.tableName}... (${p.completed}/${p.total})`);
});

// Query in plain English with history, retry, and summarization
const result = await client.query('Who are our top 5 customers by total spend?', {
  summarize: true,
  summaryMaxChars: 600,
  maxRetries: 2,
  history: [
    {
      question: 'Show all customer count',
      sql: 'SELECT COUNT(id) AS count FROM customers',
      rowCount: 1,
    }
  ],
});

if (result.error) {
  console.error('Error:', result.error);
} else {
  console.log('Generated SQL:', result.sql);
  console.log('Attempts:', result.attempts);
  console.log('Summary:', result.summary);
  console.table(result.results);
}

await client.close();
```

---

## API Reference

### `new NLSQLClient(config)`

```typescript
const client = new NLSQLClient({
  db: {
    host: string;
    port?: number;             // default: 3306
    user: string;
    password: string;
    database: string;
    connectionLimit?: number;  // default: 5
    connectTimeout?: number;   // default: 10000ms
    ssl?: any;
  },
  llm: {
    provider: 'gemini';
    apiKey: string;
    model: string;
    temperature?: number;       // default: 0.1
  },
  storage?: { type: 'file'; path?: string }
          | { type: 'mysql'; admin?: MySQLConnectionConfig };
  security?: { queryTimeoutMs?: number; maxRows?: number };
  schema?: { excludeTables?: string[]; excludeColumns?: string[] };
});
```

---

### `client.initialise(enrichOptions?, onProgress?)`

Opens connection pool and initializes storage.

```typescript
await client.initialise(
  { forceRefresh: false },
  (p) => console.log(`${p.tableName} (${p.completed}/${p.total})`)
);
```

---

### `client.query(question, options?)`

Translates a question into SQL, validates, executes, retries on syntax/schema errors, and optionally summarizes results.

```typescript
const result = await client.query('Show me pending orders', {
  maxRows: 100,
  maxRetries: 2,
  summarize: true,
  summaryMaxChars: 600,
  dialect: 'mysql',
  history: [],
});
```

**Returns `QueryResult`:**
```typescript
{
  sql: string | null;
  results: Record<string, unknown>[] | null;
  error: string | null;
  attempts: number;
  truncated: boolean;
  rowCount: number;
  summary?: string;
  columns?: string[];
  timing: {
    retrievalMs: number;
    generationMs: number;
    validationMs: number;
    executionMs: number;
    summaryMs?: number;
    totalMs: number;
  };
}
```

---

## Security

- **AST Validation**: Powered by `node-sql-parser`. Strictly enforces single `SELECT` statements (CTEs allowed). Blocks data mutation (`INSERT`, `UPDATE`, `DELETE`, `DROP`, etc.), system catalog queries (`information_schema`, `mysql`, `sys`), locking clauses (`FOR UPDATE`), INTO clauses, user/system variables, comment injection (`/*!`), and dangerous functions (`SLEEP`, `BENCHMARK`, `LOAD_FILE`).
- **Read-Only Session**: Enforces `SET SESSION TRANSACTION READ ONLY` and execution timeouts (`MAX_EXECUTION_TIME` / `max_statement_time`).
- **SELECT-Only DB User**: Still required as a database-level safety net.
- **Data sent to the LLM**:
  - Technical schema definitions, table/column comments, and column data types.
  - Up to N sample values per non-PII column for context.
  - PII columns matching `/(pass(word)?|passwd|secret|token|api[_-]?key|ssn|card[_-]?(no|number)|cvv|iban)/i` or listed in `schema.excludeColumns` are automatically excluded and never sampled or sent to Google.

---

## License

MIT
