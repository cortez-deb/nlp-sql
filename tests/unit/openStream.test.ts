/**
 * tests/unit/openStream.test.ts
 *
 * MySQLAdapter.openStream and NLSQLClient.openRowStream with mocked mysql2.
 */

import { EventEmitter } from 'events';
import { Readable } from 'stream';

jest.mock('mysql2/promise', () => ({
  __esModule: true,
  default: { createPool: jest.fn(), escapeId: (s: string) => `\`${s}\`` },
}));

import mysql from 'mysql2/promise';
import { MySQLAdapter } from '../../src/db/MySQLAdapter';

/** Fake mysql2 callback Query: emits 'fields', exposes a Readable via stream(). */
function makeFakeQuery(columns: string[], rows: Record<string, unknown>[], failWith?: Error) {
  const q = new EventEmitter() as EventEmitter & { stream: (o?: unknown) => Readable };
  q.stream = () => {
    const rs = new Readable({ objectMode: true, read() {} });
    q.on('error', (e: Error) => rs.destroy(e));
    setImmediate(() => {
      if (failWith) {
        q.emit('error', failWith);
        return;
      }
      q.emit('fields', columns.map((name) => ({ name })));
      for (const r of rows) rs.push(r);
      rs.push(null);
      q.emit('end');
    });
    return rs;
  };
  return q;
}

function makeFakePool(opts: {
  version?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  failWith?: Error;
}) {
  const conns: any[] = [];
  const makeConn = () => {
    const conn: any = {
      query: jest.fn().mockImplementation(async (sql: string) =>
        /VERSION/.test(sql) ? [[{ ver: opts.version ?? '8.0.36' }]] : [[]]
      ),
      release: jest.fn(),
      destroy: jest.fn(),
      connection: {
        query: jest.fn().mockImplementation(() =>
          makeFakeQuery(opts.columns ?? ['id', 'name'], opts.rows ?? [], opts.failWith)
        ),
      },
    };
    conns.push(conn);
    return conn;
  };
  const pool: any = {
    getConnection: jest.fn().mockImplementation(async () => makeConn()),
    end: jest.fn().mockResolvedValue(undefined),
    pool: { on: jest.fn() },
  };
  (mysql.createPool as jest.Mock).mockReturnValue(pool);
  return { pool, conns };
}

const dbConfig = { host: 'h', user: 'u', password: 'p', database: 'd' };

describe('MySQLAdapter.openStream', () => {
  beforeEach(() => jest.clearAllMocks());

  it('streams all rows and reports columns before the first row', async () => {
    const rows = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 3, name: 'c' },
    ];
    makeFakePool({ rows });
    const adapter = await MySQLAdapter.create(dbConfig);
    const stream = await adapter.openStream('SELECT id, name FROM t', { timeoutMs: 5000 });

    expect(stream.columns).toEqual(['id', 'name']);
    const got: unknown[] = [];
    for await (const r of stream.rows) got.push(r);
    expect(got).toEqual(rows);
    await stream.destroy();
  });

  it('sets MAX_EXECUTION_TIME on MySQL and max_statement_time (seconds) on MariaDB', async () => {
    const my = makeFakePool({});
    const a1 = await MySQLAdapter.create(dbConfig);
    const s1 = await a1.openStream('SELECT 1', { timeoutMs: 7500 });
    const sessionCalls1 = my.conns.flatMap((c) => c.query.mock.calls.map((x: any[]) => x[0]));
    expect(sessionCalls1).toContain('SET SESSION MAX_EXECUTION_TIME = 7500');
    await s1.destroy();

    const maria = makeFakePool({ version: '10.11.2-MariaDB' });
    const a2 = await MySQLAdapter.create(dbConfig);
    const s2 = await a2.openStream('SELECT 1', { timeoutMs: 7500 });
    const sessionCalls2 = maria.conns.flatMap((c) => c.query.mock.calls.map((x: any[]) => x[0]));
    expect(sessionCalls2).toContain('SET SESSION max_statement_time = 8');
    await s2.destroy();
  });

  it('destroy() is idempotent and destroys (not releases) the connection', async () => {
    const { conns } = makeFakePool({ rows: [{ id: 1, name: 'a' }] });
    const adapter = await MySQLAdapter.create(dbConfig);
    const stream = await adapter.openStream('SELECT id, name FROM t', { timeoutMs: 5000 });

    await stream.destroy();
    await stream.destroy();

    const streamConn = conns[conns.length - 1];
    expect(streamConn.destroy).toHaveBeenCalledTimes(1);
    expect(streamConn.release).not.toHaveBeenCalled();
  });

  it('rejects and discards the connection when the query errors before fields', async () => {
    const { conns } = makeFakePool({ failWith: new Error('boom') });
    const adapter = await MySQLAdapter.create(dbConfig);

    await expect(adapter.openStream('SELECT bad', { timeoutMs: 5000 })).rejects.toThrow('boom');
    expect(conns[conns.length - 1].destroy).toHaveBeenCalledTimes(1);
  });
});
