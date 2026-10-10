/**
 * examples/export-usage.ts
 *
 * Runs a query, then exports the SQL it produced to a CSV file and prints the
 * download URL.
 *
 * To run (against the shop_sample.sql database):
 *   export DB_PASSWORD=... GEMINI_API_KEY=... GEMINI_MODEL=...
 *   export EXPORT_ROOT_DIR="$(mktemp -d)"
 *   export EXPORT_BASE_URL=http://localhost:3000/downloads
 *   npx ts-node src/examples/export-usage.ts
 *
 * Then open the printed file in a spreadsheet. A UTF-8 name such as "Zoë"
 * should display correctly, and a value like "=1+1" should show as text.
 *
 * Environment variables: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME,
 * GEMINI_API_KEY, GEMINI_MODEL, plus the EXPORT_* variables (see .env.example).
 */

import * as path from 'path';
import { NLSQLClient, CsvExportService, loadExportConfigFromEnv } from '../index';

async function main() {
  try {
    process.loadEnvFile?.();
  } catch {
    // .env file missing or already loaded in environment
  }

  const dbPassword = process.env['DB_PASSWORD'];
  if (!dbPassword) throw new Error('Environment variable DB_PASSWORD is required');
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) throw new Error('Environment variable GEMINI_API_KEY is required');
  const model = process.env['GEMINI_MODEL'];
  if (!model) throw new Error('Environment variable GEMINI_MODEL is required');

  // Validates EXPORT_ROOT_DIR (exists, writable) and EXPORT_BASE_URL (https, or localhost).
  const exportConfig = loadExportConfigFromEnv();

  const client = new NLSQLClient({
    db: {
      host: process.env['DB_HOST'] ?? 'localhost',
      user: process.env['DB_USER'] ?? 'root',
      password: dbPassword,
      database: process.env['DB_NAME'] ?? 'shop',
    },
    llm: { provider: 'gemini', apiKey, model },
    export: { timeoutMs: exportConfig.timeoutMs },
  });

  try {
    await client.initialise({ forceRefresh: false, sampleSize: 5 });

    const question = process.argv[2] ?? 'List all customers with their loyalty tier';
    console.log(`Question: ${question}`);

    const result = await client.query(question);
    if (result.error !== null || !result.sql) {
      throw new Error(`Query failed: ${result.error ?? 'no SQL produced'}`);
    }
    console.log(`Preview: ${result.rowCount} row(s)${result.truncated ? ' (truncated)' : ''}`);
    console.log(`SQL: ${result.sql}`);

    // The owner id is the web app's notion of "who owns this file". In the bot it
    // is derived from the allowlisted sender's phone number digits.
    const exporter = new CsvExportService(client, exportConfig);
    const exported = await exporter.export({
      ownerId: process.env['EXPORT_OWNER_ID'] ?? 'demo',
      sql: result.sql,
      question,
    });

    if (!exported.ok) {
      throw new Error(`Export failed (${exported.code}): ${exported.error}`);
    }

    console.log('');
    console.log(
      `Export ready: ${exported.rowCount} rows, ${exported.columns.length} columns, ` +
        `${exported.bytes} bytes.`
    );
    console.log(`URL:  ${exported.url}`);
    console.log(`File: ${path.join(exportConfig.rootDir, exported.relativePath)}`);
    console.log(`Expires: ${exported.expiresAt}`);
    if (exported.truncated) {
      console.log(`Limited by ${exported.truncatedReason}.`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
