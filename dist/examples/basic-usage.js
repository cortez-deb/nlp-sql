"use strict";
/**
 * examples/basic-usage.ts
 *
 * This file shows how to use the nlsql library from start to finish.
 * It covers:
 *  1. Creating and initialising the client
 *  2. Running the schema enrichment pipeline
 *  3. Querying in plain English
 *  4. Handling errors
 *  5. Cleaning up
 *
 * To run this example:
 *   1. Set environment variables (see below)
 *   2. npx ts-node examples/basic-usage.ts
 *
 * Required environment variables:
 *   DB_HOST       - MySQL host (default: localhost)
 *   DB_USER       - MySQL username
 *   DB_PASSWORD   - MySQL password
 *   DB_NAME       - MySQL database name
 *   GEMINI_API_KEY - Your Google Gemini API key
 */
Object.defineProperty(exports, "__esModule", { value: true });
const src_1 = require("../index.js");
async function main() {
    // ── Step 1: Create the client ──────────────────────────────────────────────
    //
    // Pass your database and LLM credentials here.
    // Best practice: load these from environment variables, never hardcode them.
    const client = new src_1.NLSQLClient({
        db: {
            host: process.env['DB_HOST'] ?? 'localhost',
            port: 3306,
            user: process.env['DB_USER'] ?? '',
            password: process.env['DB_PASSWORD'] ?? '',
            database: process.env['DB_NAME'] ?? 'shop',
            // Use a small connection pool for this example
            connectionLimit: 3,
        },
        llm: {
            provider: 'ollama',
            apiKey: '',
            model: 'gpt-oss:120b-cloud',
            baseURL: 'http://192.168.100.122:11434'
        },
    });
    try {
        // ── Step 2: Initialise and enrich the schema ─────────────────────────────
        //
        // On the FIRST run: pass enrichment options to describe your schema.
        // On subsequent runs: call initialise() without options to reuse stored enrichments.
        console.log('Connecting to database and enriching schema...\n');
        const summary = await client.initialise({
            forceRefresh: false, // Use cached enrichments if schema hasn't changed
            sampleSize: 5, // Collect 5 sample values per column
        }, 
        // Progress callback — called after each table is processed
        (progress) => {
            const action = progress.wasEnriched ? '✓ enriched' : '⊙ cached';
            console.log(`  ${action}: ${progress.tableName} ` +
                `(${progress.completed}/${progress.total})`);
        });
        if (summary) {
            console.log(`\nEnrichment complete: ${summary.enriched} enriched, ` +
                `${summary.skipped} cached, ${summary.failed.length} failed ` +
                `(${summary.durationMs}ms)\n`);
        }
        // ── Step 3: Query in plain English ────────────────────────────────────────
        //
        // Now you can ask questions about your data in plain English.
        // Each call to query() runs the full pipeline:
        //   retrieve schema → generate SQL → validate → execute
        // Optional: provide few-shot examples to improve accuracy for your schema
        const examples = [
            {
                question: 'Show me all orders',
                sql: 'SELECT orders.id, orders.total_amount, orders.status FROM orders LIMIT 100',
            },
            {
                question: 'How many customers signed up last month?',
                sql: `SELECT COUNT(customers.id) AS count
              FROM customers
              WHERE customers.created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)`,
            },
        ];
        // Query 1: Simple count
        console.log('─'.repeat(60));
        console.log('Q: How many orders were placed this week?');
        const result1 = await client.query('How many orders were placed this week?', {
            fewShotExamples: examples,
        });
        if (result1.error) {
            console.error('Error:', result1.error);
        }
        else {
            console.log('SQL:', result1.sql);
            console.log('Results:', result1.results);
            console.log(`Timing: ${result1.timing.totalMs}ms total`);
        }
        // Query 2: Ranked list
        console.log('\n' + '─'.repeat(60));
        console.log('Q: Who are our top 5 customers by total spend?');
        const result2 = await client.query('Who are our top 5 customers by total spend?', {
            maxRows: 5,
            fewShotExamples: examples,
        });
        if (result2.error) {
            console.error('Error:', result2.error);
        }
        else {
            console.log('SQL:', result2.sql);
            console.table(result2.results);
        }
        // Query 3: Filtered with status
        console.log('\n' + '─'.repeat(60));
        console.log('Q: Show me all pending orders');
        const result3 = await client.query("Show me all pending orders", {
            maxRows: 20,
        });
        if (result3.error) {
            console.error('Error:', result3.error);
        }
        else {
            console.log('SQL:', result3.sql);
            console.log(`${result3.results?.length} rows returned`);
        }
        // ── Step 4: Inspect the enriched schema (optional) ────────────────────────
        //
        // You can see exactly what the LLM knows about your database.
        // Useful for debugging when queries aren't matching the right tables.
        // console.log('\n' + '─'.repeat(60));
        // console.log('Enriched schema overview:');
        // const enrichedTables = await client.getEnrichedSchema();
        // for (const table of enrichedTables) {
        //     console.log(`\n  ${table.tableName} → "${table.businessName}"`);
        //     console.log(`  Synonyms: ${table.synonyms.join(', ')}`);
        //     console.log(`  Columns: ${table.columns.map((c) => c.name).join(', ')}`);
        // }
        // ── Step 5: Standalone SQL validation (optional) ──────────────────────────
        //
        // You can validate SQL strings without executing them.
        // Useful for testing and debugging.
        console.log('\n' + '─'.repeat(60));
        const dangerousSQL = 'DROP TABLE customers';
        const validation = client.validateSQL(dangerousSQL);
        console.log(`\nValidation of "${dangerousSQL}":`);
        console.log(`  Valid: ${validation.isValid}`);
        console.log(`  Reason: ${validation.reason}`);
    }
    finally {
        // ── Step 6: Always close the client when done ─────────────────────────────
        //
        // This releases all database connections. Without this, your Node.js
        // process will hang because the connection pool keeps it alive.
        await client.close();
        console.log('\nConnection closed. Goodbye!');
    }
}
// Run the example and handle any unexpected top-level errors
main().catch((err) => {
    console.error('Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
});
//# sourceMappingURL=basic-usage.js.map