# nlsql

**Natural Language to SQL** — Ask questions in plain English, get database results back.

`nlsql` connects to your MySQL database, uses an LLM (Google Gemini,OpenAI,Ollama) to understand your schema and the user's question, generates a validated read-only SQL query, and returns the results.

---

## How it works

```
User question → [Retrieve schema context] → [LLM generates SQL]
              → [Validate: SELECT only]   → [Execute] → Results
```

The **enrichment pipeline** (run once at setup) uses LLM to translate your technical schema into business-friendly descriptions, stored in a `nlsql_enriched_schema` table in your own database. This powers accurate natural language matching at query time.

---

## Installation

```bash
npm install nlsql
```

---

## Quick Start

```typescript
import { NLSQLClient } from 'nlsql';

// ── Option A: Google Gemini ───────────────────────────────────────────────────
const client = new NLSQLClient({
  db: {
    host: 'localhost',
    user: 'readonly_user',
    password: process.env.DB_PASSWORD!,
    database: 'my_app',
  },
  llm: {
    provider: 'gemini',
    apiKey: process.env.GEMINI_API_KEY!,
    model: 'gemini-1.5-flash-latest',   // or 'gemini-1.5-pro-latest', 'gemini-2.0-flash'
  },
});

// ── Option B: OpenAI ──────────────────────────────────────────────────────────
const client = new NLSQLClient({
  db: { host: 'localhost', user: 'readonly_user', password: process.env.DB_PASSWORD!, database: 'my_app' },
  llm: {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini',   // or 'gpt-4o', 'gpt-4-turbo'
  },
});

// ── Option C: Ollama (local, no API key needed) ───────────────────────────────
// First: `ollama pull llama3.1` then `ollama serve`
const client = new NLSQLClient({
  db: { host: 'localhost', user: 'readonly_user', password: process.env.DB_PASSWORD!, database: 'my_app' },
  llm: {
    provider: 'ollama',
    apiKey: '',                          // Not needed for local models
    model: 'llama3.1',                   // or 'mistral', 'codellama', 'deepseek-coder'
    baseURL: 'http://localhost:11434',   // Optional — this is the default
  },
});

// First run: enrich the schema (uses LLM to understand your tables)
await client.initialise({ forceRefresh: false }, (p) => {
  console.log(`Enriching ${p.tableName}... (${p.completed}/${p.total})`);
});

// Query in plain English
const result = await client.query('Who are our top 5 customers by total spend?');

if (result.error) {
  console.error('Error:', result.error);
} else {
  console.log('Generated SQL:', result.sql);
  console.table(result.results);
}

await client.close();
```

---

## API Reference

### `new NLSQLClient(config)`

Creates a new client. Does not open a database connection — call `initialise()` for that.

```typescript
const client = new NLSQLClient({
  db: {
    host: string;
    port?: number;           // default: 3306
    user: string;
    password: string;
    database: string;
    connectionLimit?: number; // default: 5
    connectTimeout?: number;  // default: 10000ms
  },
  llm: {
    provider: 'gemini';
    apiKey: string;
    model: string;            // e.g. 'gemini-1.5-flash-latest'
    temperature?: number;     // default: 0.1
  },
});
```

---

### `client.initialise(enrichOptions?, onProgress?)`

Opens the database connection and optionally runs enrichment.

```typescript
// First run: with enrichment
await client.initialise(
  { forceRefresh: false },
  (p) => console.log(`${p.tableName} (${p.completed}/${p.total})`)
);

// Subsequent runs: skip enrichment (use cached)
await client.initialise();
```

**EnrichmentOptions:**
| Option | Type | Default | Description |
|---|---|---|---|
| `forceRefresh` | boolean | `false` | Re-enrich all tables even if unchanged |
| `tables` | string[] | all tables | Restrict enrichment to specific tables |
| `sampleSize` | number | `5` | Sample values per column for LLM context |

---

### `client.query(question, options?)`

Translates a plain English question into SQL and executes it.

```typescript
const result = await client.query('Show me pending orders from last week', {
  fewShotExamples: [
    {
      question: 'How many orders today?',
      sql: "SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURDATE()",
    }
  ],
  maxRows: 100,           // default: 1000
  maxContextTables: 5,    // default: 5
});
```

**Returns `QueryResult`:**
```typescript
{
  sql: string | null;                      // The generated SQL
  results: Record<string, unknown>[] | null; // Result rows
  error: string | null;                    // Error message if failed
  timing: {
    retrievalMs: number;
    generationMs: number;
    validationMs: number;
    executionMs: number;
    totalMs: number;
  };
}
```

---

### `client.enrich(options?, onProgress?)`

Runs the enrichment pipeline independently of `initialise()`.

```typescript
const summary = await client.enrich({ forceRefresh: true });
console.log(`Enriched: ${summary.enriched}, Skipped: ${summary.skipped}`);
```

---

### `client.validateSQL(sql)`

Validates a SQL string without executing it. Does not require `initialise()`.

```typescript
const result = client.validateSQL('DROP TABLE users');
// { isValid: false, reason: 'Blocked keyword detected: DROP' }
```

---

### `client.getEnrichedSchema()`

Returns all stored enriched table descriptions. Useful for debugging.

```typescript
const tables = await client.getEnrichedSchema();
tables.forEach(t => console.log(`${t.tableName} → ${t.businessName}`));
```

---

### `client.close()`

Closes all database connections. Always call this when done.

```typescript
await client.close();
```

---

## Security

- **Always use a read-only MySQL user.** `nlsql` enforces this in software (the validator rejects non-SELECT statements), but a read-only DB user is your hardware-enforced safety net.
- The SQL validator rejects: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `REPLACE`, `RENAME`, `GRANT`, `REVOKE`, `CALL`, `EXEC`, `EXECUTE`, `LOAD`.
- Multiple statements (`;` separated) are rejected.
- SQL comments are stripped before keyword scanning to prevent bypass attempts.

**Creating a read-only MySQL user:**
```sql
CREATE USER 'nlsql_readonly'@'%' IDENTIFIED BY 'strong_password';
GRANT SELECT ON your_database.* TO 'nlsql_readonly'@'%';
FLUSH PRIVILEGES;
```

---

## Running tests

```bash
npm test              # Run all tests
npm run test:coverage # Run with coverage report
npm run test:watch    # Watch mode
```

---

## Building

```bash
npm run build         # Compile TypeScript to dist/
npm run lint          # Type-check without emitting
```

---

## Checking Ollama status

Before running with Ollama, verify the server is up and your model is available:

```typescript
import { OllamaLLM } from 'nlsql';

const status = await OllamaLLM.checkServer('http://localhost:11434', 'llama3.1');

if (!status.running) {
  console.error('Ollama is not running. Start it with: ollama serve');
} else if (!status.modelAvailable) {
  console.error(`Model not found. Pull it: ollama pull llama3.1`);
  console.log('Available models:', status.availableModels);
} else {
  console.log('Ready!');
}
```

Recommended models for SQL generation:

| Model | Command | Notes |
|---|---|---|
| `llama3.1` | `ollama pull llama3.1` | Best all-rounder |
| `mistral` | `ollama pull mistral` | Good structured output |
| `codellama` | `ollama pull codellama` | Code/SQL focused |
| `deepseek-coder` | `ollama pull deepseek-coder` | Strong SQL |
| `qwen2.5-coder` | `ollama pull qwen2.5-coder` | Alibaba code model |

---

## Adding a new LLM provider

Extend `BaseLLM` and implement `enrichTable()` and `generateSQL()`:

```typescript
import { BaseLLM } from 'nlsql';

class MyLLM extends BaseLLM {
  async enrichTable(rawTable, schemaHash) {
    // Call your LLM API here
    const response = await myLLMApi.call(this.buildEnrichmentPrompt(rawTable));
    return this.parseEnrichmentResponse(response, rawTable, schemaHash);
  }

  async generateSQL(userQuery, contextTables, fewShotExamples = []) {
    const schema = this.buildSchemaContext(contextTables);
    const examples = this.buildFewShotBlock(fewShotExamples);
    const sql = await myLLMApi.call(`${schema}\n${examples}\n${userQuery}`);
    return this.extractSQL(sql);
  }
}
```

---

## License

MIT
