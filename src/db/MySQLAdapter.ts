/**
 * db/MySQLAdapter.ts
 *
 * Direct communication with MySQL via mysql2 promise pools.
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

export interface ExecuteQueryOptions {
  hasTopLevelLimit?: boolean;
  timeoutMs?: number;
}

export interface ExecuteQueryResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
}

export class MySQLAdapter {
  private readonly pool: Pool;
  private readonly databaseName: string;

  private constructor(pool: Pool, databaseName: string) {
    this.pool = pool;
    this.databaseName = databaseName;
  }

  static async create(config: MySQLConnectionConfig): Promise<MySQLAdapter> {
    const pool = mysql.createPool({
      host: config.host,
      port: config.port ?? 3306,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.connectionLimit ?? 5,
      connectTimeout: config.connectTimeout ?? 10_000,
      multipleStatements: false,
      dateStrings: true,
      decimalNumbers: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      waitForConnections: true,
      queueLimit: 0,
      ssl: config.ssl,
      rowsAsArray: false,
      typeCast: true,
    });

    let isMariaDB = false;
    let testConn: PoolConnection | undefined;
    try {
      testConn = await pool.getConnection();
      const [verRows] = await testConn.query<RowDataPacket[]>('SELECT VERSION() AS ver');
      const verStr = String(verRows[0]?.['ver'] ?? '');
      isMariaDB = /mariadb/i.test(verStr);
    } catch (err) {
      await pool.end().catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[nlsql] Could not connect to MySQL at ${config.host}:${config.port ?? 3306} ` +
        `(database: ${config.database}). Original error: ${message}`
      );
    } finally {
      testConn?.release();
    }

    const defaultTimeoutMs = config.connectTimeout ?? 10_000;
    const rawPool = (pool as any).pool;
    if (rawPool && typeof rawPool.on === 'function') {
      rawPool.on('connection', (conn: any) => {
        conn.query('SET SESSION TRANSACTION READ ONLY', () => {});
        if (isMariaDB) {
          const secs = Math.max(1, Math.ceil(defaultTimeoutMs / 1000));
          conn.query(`SET SESSION max_statement_time = ${secs}`, () => {});
        } else {
          conn.query(`SET SESSION MAX_EXECUTION_TIME = ${defaultTimeoutMs}`, () => {});
        }
      });
    }

    return new MySQLAdapter(pool, config.database);
  }

  async getSchema(tableNames?: string[]): Promise<RawTable[]> {
    const tableFilter = tableNames && tableNames.length > 0
      ? `AND t.TABLE_NAME IN (${tableNames.map(() => '?').join(', ')})`
      : '';

    const tableParams: string[] = [
      this.databaseName,
      ...(tableNames ?? []),
    ];

    const [tableRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
         TABLE_NAME    AS tableName,
         TABLE_COMMENT AS tableComment,
         TABLE_ROWS    AS tableRows
       FROM information_schema.TABLES t
       WHERE t.TABLE_SCHEMA = ?
         AND t.TABLE_TYPE   = 'BASE TABLE'
         AND t.TABLE_NAME   NOT LIKE 'nlsql\_%'
         ${tableFilter}
       ORDER BY t.TABLE_NAME`,
      tableParams
    );

    if (tableRows.length === 0) {
      return [];
    }

    const allTableNames = tableRows.map((r) => r['tableName'] as string);

    const [colRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
         TABLE_NAME       AS tableName,
         COLUMN_NAME      AS columnName,
         DATA_TYPE        AS dataType,
         COLUMN_TYPE      AS columnType,
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

    const colsByTable = new Map<string, RawColumn[]>();
    for (const row of colRows) {
      const tName = row['tableName'] as string;
      if (!colsByTable.has(tName)) colsByTable.set(tName, []);
      colsByTable.get(tName)!.push({
        columnName: row['columnName'] as string,
        dataType: row['dataType'] as string,
        columnType: row['columnType'] as string | undefined,
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

  async sampleColumn(
    tableName: string,
    columnName: string,
    limit = 5
  ): Promise<string> {
    try {
      const tableEsc = mysql.escapeId(tableName);
      const colEsc = mysql.escapeId(columnName);
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT DISTINCT CAST(${colEsc} AS CHAR) AS val
         FROM ${tableEsc}
         WHERE ${colEsc} IS NOT NULL
         LIMIT ?`,
        [limit]
      );

      return rows
        .map((r) => String(r['val']))
        .filter((v) => v !== 'null' && v !== '')
        .join(', ');
    } catch {
      return '';
    }
  }

  async executeQuery(
    sql: string,
    maxRows = 1000,
    opts?: ExecuteQueryOptions
  ): Promise<ExecuteQueryResult> {
    let finalSql = sql;
    if (!opts?.hasTopLevelLimit) {
      finalSql = `${sql.trimEnd().replace(/;$/, '')} LIMIT ${maxRows}`;
    }

    const timeoutMs = opts?.timeoutMs ?? 10_000;
    const [rows] = await this.pool.query<RowDataPacket[]>({
      sql: finalSql,
      timeout: timeoutMs + 2000,
    });

    const mappedRows = (rows as RowDataPacket[]).map((row) => ({ ...row }));
    const truncated = mappedRows.length > maxRows;
    const finalRows = mappedRows.slice(0, maxRows);

    return {
      rows: finalRows,
      truncated,
    };
  }

  async rawQuery<T extends RowDataPacket[]>(
    sql: string,
    params: unknown[] = []
  ): Promise<T> {
    const [rows] = await this.pool.query<T>(sql, params);
    return rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
