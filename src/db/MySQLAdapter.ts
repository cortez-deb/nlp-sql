/**
 * db/MySQLAdapter.ts
 *
 * This class is responsible for ALL direct communication with MySQL.
 * It handles:
 *  1. Opening and managing a connection pool (reusing connections efficiently)
 *  2. Reading the database schema from INFORMATION_SCHEMA
 *  3. Executing validated SELECT queries and returning results
 *  4. Providing a clean way to close all connections when done
 *
 * Everything in this file is an implementation detail — users of the library
 * never call this class directly. They go through NLSQLClient instead.
 */

import mysql, {
  Pool,
  PoolConnection,
  RowDataPacket,
} from 'mysql2/promise';

import type {
  MySQLConnectionConfig,
  RawTable,
  RawColumn,
  ForeignKeyInfo,
} from '../types';

/**
 * MySQLAdapter wraps mysql2's connection pool and provides typed,
 * higher-level methods for the nlsql library.
 *
 * Use `MySQLAdapter.create(config)` (the static factory method) instead of
 * `new MySQLAdapter(...)` — it validates the connection before returning.
 *
 * @example
 * const adapter = await MySQLAdapter.create({
 *   host: 'localhost',
 *   user: 'readonly_user',
 *   password: 'secret',
 *   database: 'my_app_db',
 * });
 *
 * const tables = await adapter.getSchema();
 * await adapter.close();
 */
export class MySQLAdapter {
  /**
   * The underlying mysql2 connection pool.
   * A pool manages multiple open connections and lends them out as needed.
   * This avoids the overhead of opening a new TCP connection on every query.
   */
  private readonly pool: Pool;

  /**
   * The name of the database we are connected to.
   * Used when querying INFORMATION_SCHEMA to filter to only our tables.
   */
  private readonly databaseName: string;

  /**
   * Private constructor — use `MySQLAdapter.create()` instead.
   * This ensures the connection is validated before the adapter is used.
   */
  private constructor(pool: Pool, databaseName: string) {
    this.pool = pool;
    this.databaseName = databaseName;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FACTORY METHOD
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a new MySQLAdapter and verifies the connection is working.
   *
   * This is the correct way to instantiate this class. It opens the
   * connection pool and runs a simple "SELECT 1" ping to confirm the
   * database is reachable before returning.
   *
   * @param config - MySQL connection details (host, user, password, database, etc.)
   * @returns A ready-to-use MySQLAdapter instance.
   * @throws Error if the connection cannot be established.
   *
   * @example
   * const adapter = await MySQLAdapter.create({
   *   host: 'localhost',
   *   user: 'root',
   *   password: 'secret',
   *   database: 'shop',
   * });
   */
  static async create(config: MySQLConnectionConfig): Promise<MySQLAdapter> {
    // Create the connection pool. mysql2 will open connections lazily
    // (only when a query is first made), but we ping immediately below.
    const pool = mysql.createPool({
      host: config.host,
      port: config.port ?? 3306,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.connectionLimit ?? 5,
      connectTimeout: config.connectTimeout ?? 10_000,
      // Always return plain JavaScript objects, not mysql2's custom types
      rowsAsArray: false,
      // Cast MySQL numeric types to JS numbers automatically
      typeCast: true,
    });

    // Borrow a connection from the pool and immediately return it,
    // just to confirm the credentials and host are correct.
    let testConn: PoolConnection | undefined;
    try {
      testConn = await pool.getConnection();
      await testConn.ping();
    } catch (err) {
      // If connection fails, destroy the pool before throwing
      await pool.end().catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[nlsql] Could not connect to MySQL at ${config.host}:${config.port ?? 3306} ` +
        `(database: ${config.database}). Original error: ${message}`
      );
    } finally {
      // Always release the connection back to the pool
      testConn?.release();
    }

    return new MySQLAdapter(pool, config.database);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SCHEMA INTROSPECTION
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Reads the full database schema by querying MySQL's INFORMATION_SCHEMA
   * system database. Returns a structured list of tables and their columns.
   *
   * INFORMATION_SCHEMA is a built-in MySQL database that stores metadata
   * about all other databases — their tables, columns, keys, etc.
   *
   * @param tableNames - Optional list of table names to restrict to.
   *                     If omitted, all user-created tables are returned.
   * @returns An array of RawTable objects, each with its columns and foreign keys.
   *
   * @example
   * // Get all tables
   * const tables = await adapter.getSchema();
   *
   * // Get only specific tables
   * const tables = await adapter.getSchema(['orders', 'customers']);
   */
  async getSchema(tableNames?: string[]): Promise<RawTable[]> {
    // ── Step 1: Fetch all tables ──────────────────────────────────────────

    // Build the WHERE clause. If tableNames is provided, add an IN filter.
    const tableFilter = tableNames && tableNames.length > 0
      ? `AND t.TABLE_NAME IN (${tableNames.map(() => '?').join(', ')})`
      : '';

    const tableParams: string[] = [
      this.databaseName,
      ...(tableNames ?? []),
    ];

    // We exclude views (TABLE_TYPE = 'VIEW') because they may produce
    // unpredictable results when the LLM tries to query them.
    const [tableRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
         TABLE_NAME    AS tableName,
         TABLE_COMMENT AS tableComment,
         TABLE_ROWS    AS tableRows
       FROM information_schema.TABLES t
       WHERE t.TABLE_SCHEMA = ?
         AND t.TABLE_TYPE   = 'BASE TABLE'
         ${tableFilter}
       ORDER BY t.TABLE_NAME`,
      tableParams
    );

    if (tableRows.length === 0) {
      return [];
    }

    // ── Step 2: Fetch all columns for the above tables ────────────────────

    const allTableNames = tableRows.map((r) => r['tableName'] as string);

    const [colRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
         TABLE_NAME       AS tableName,
         COLUMN_NAME      AS columnName,
         DATA_TYPE        AS dataType,
         IS_NULLABLE      AS isNullable,
         ORDINAL_POSITION AS ordinalPosition,
         COLUMN_DEFAULT   AS columnDefault,
         EXTRA            AS extra,
         COLUMN_KEY       AS columnKey,
         COLUMN_COMMENT   AS columnComment
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME   IN (${allTableNames.map(() => '?').join(', ')})
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [this.databaseName, ...allTableNames]
    );

    // ── Step 3: Fetch all foreign key relationships ───────────────────────

    const [fkRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
         kcu.TABLE_NAME        AS tableName,
         kcu.COLUMN_NAME       AS columnName,
         kcu.REFERENCED_TABLE_NAME  AS referencedTable,
         kcu.REFERENCED_COLUMN_NAME AS referencedColumn
       FROM information_schema.KEY_COLUMN_USAGE kcu
       WHERE kcu.TABLE_SCHEMA = ?
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         AND kcu.TABLE_NAME IN (${allTableNames.map(() => '?').join(', ')})`,
      [this.databaseName, ...allTableNames]
    );

    // ── Step 4: Assemble everything into RawTable objects ─────────────────

    // Group columns and foreign keys by table name for easy lookup
    const colsByTable = new Map<string, RawColumn[]>();
    for (const row of colRows) {
      const tName = row['tableName'] as string;
      if (!colsByTable.has(tName)) colsByTable.set(tName, []);
      colsByTable.get(tName)!.push({
        columnName: row['columnName'] as string,
        dataType: row['dataType'] as string,
        isNullable: row['isNullable'] as string,
        ordinalPosition: row['ordinalPosition'] as number,
        columnDefault: row['columnDefault'] as string | null,
        extra: row['extra'] as string,
        columnKey: row['columnKey'] as string,
        columnComment: row['columnComment'] as string,
      });
    }

    const fksByTable = new Map<string, ForeignKeyInfo[]>();
    for (const row of fkRows) {
      const tName = row['tableName'] as string;
      if (!fksByTable.has(tName)) fksByTable.set(tName, []);
      fksByTable.get(tName)!.push({
        columnName: row['columnName'] as string,
        referencedTable: row['referencedTable'] as string,
        referencedColumn: row['referencedColumn'] as string,
      });
    }

    return tableRows.map((row) => {
      const tableName = row['tableName'] as string;
      return {
        tableName,
        tableComment: (row['tableComment'] as string) ?? '',
        tableRows: Number(row['tableRows'] ?? 0),
        columns: colsByTable.get(tableName) ?? [],
        foreignKeys: fksByTable.get(tableName) ?? [],
      };
    });
  }

  /**
   * Collects a small sample of actual values from a column.
   * These samples help the LLM understand the kind of data stored
   * (e.g. seeing "pending, shipped, delivered" tells the LLM what
   * the status column values look like in real life).
   *
   * Only non-null, distinct values are returned.
   * The column is cast to CHAR to handle all data types uniformly.
   *
   * @param tableName  - Name of the table.
   * @param columnName - Name of the column to sample.
   * @param limit      - How many distinct values to retrieve. Defaults to 5.
   * @returns A comma-separated string of sample values, or empty string.
   *
   * @example
   * const samples = await adapter.sampleColumn('orders', 'status', 5);
   * // Returns: "pending, shipped, delivered, cancelled"
   */
  async sampleColumn(
    tableName: string,
    columnName: string,
    limit = 5
  ): Promise<string> {
    try {
      // We cast to CHAR so dates, numbers, enums etc. all come back as strings.
      // Backtick-quoting table/column names prevents SQL injection here
      // (even though this is internal code, it's good practice).
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT DISTINCT CAST(\`${columnName}\` AS CHAR) AS val
         FROM \`${tableName}\`
         WHERE \`${columnName}\` IS NOT NULL
         LIMIT ?`,
        [limit]
      );

      return rows
        .map((r) => String(r['val']))
        .filter((v) => v !== 'null' && v !== '')
        .join(', ');
    } catch {
      // If sampling fails (e.g. permission denied, unsupported type),
      // we silently return empty — enrichment can proceed without samples.
      return '';
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // QUERY EXECUTION
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Executes a SQL query and returns the result rows.
   *
   * This method should ONLY be called with queries that have already
   * passed through SQLValidator. Never pass raw LLM output here directly.
   *
   * @param sql     - The validated SELECT SQL query to run.
   * @param maxRows - Maximum number of rows to return (safety cap).
   * @returns An array of result rows, each as a plain key-value object.
   * @throws Error if the query fails to execute.
   *
   * @example
   * const rows = await adapter.executeQuery(
   *   'SELECT id, name FROM customers LIMIT 10',
   *   100
   * );
   */
  async executeQuery(
    sql: string,
    maxRows = 1000
  ): Promise<Record<string, unknown>[]> {
    // Append a LIMIT if the query doesn't already have one.
    // This is a safety net against accidentally loading millions of rows.
    const sqlWithLimit = this.ensureLimit(sql, maxRows);

    const [rows] = await this.pool.query<RowDataPacket[]>(sqlWithLimit);

    // mysql2 returns rows with a special prototype. We spread each row
    // into a plain object so the library's output is predictable.
    return (rows as RowDataPacket[]).map((row) => ({ ...row }));
  }

  /**
   * Runs a raw query with no safety checks — used internally for
   * creating/reading the enrichment storage table.
   *
   * @internal Not part of the public API.
   */
  async rawQuery<T extends RowDataPacket[]>(
    sql: string,
    params: unknown[] = []
  ): Promise<T> {
    const [rows] = await this.pool.query<T>(sql, params);
    return rows;
  }

  /**
   * Closes all connections in the pool.
   * Always call this when you are done using the adapter to free resources.
   *
   * @example
   * await adapter.close();
   */
  async close(): Promise<void> {
    await this.pool.end();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Checks whether a SQL query already contains a LIMIT clause.
   * If not, appends one to prevent runaway result sets.
   *
   * This is a simple string check, not a full AST parse — it's intentionally
   * conservative. The AST validator (SQLValidator) handles deeper analysis.
   *
   * @param sql     - The SQL query string.
   * @param maxRows - The limit to append if none exists.
   * @returns The SQL string, guaranteed to have a LIMIT clause.
   */
  private ensureLimit(sql: string, maxRows: number): string {
    // Case-insensitive check for "LIMIT" as a whole word
    if (/\bLIMIT\b/i.test(sql)) {
      return sql;
    }
    return `${sql.trimEnd().replace(/;$/, '')} LIMIT ${maxRows}`;
  }
}
