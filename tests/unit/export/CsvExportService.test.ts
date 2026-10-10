/**
 * tests/unit/export/CsvExportService.test.ts
 */

import { createHash } from 'crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, symlinkSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { parse } from 'csv-parse/sync';

import { CsvExportService } from '../../../src/export/CsvExportService';
import { SqlRejectedError } from '../../../src/core/errors';
import type { ExportConfig, ExportResult, RowStreamSource } from '../../../src/export/types';
import { FILE_NAME_RE } from '../../../src/export/paths';
import type { RowStream } from '../../../src/db/MySQLAdapter';

type Row = Record<string, unknown>;

interface FakeStream extends RowStream {
  destroy: jest.Mock<Promise<void>, []>;
}

function makeStream(columns: string[], source: Readable): FakeStream {
  const destroy = jest.fn(async () => {
    if (!source.destroyed) source.destroy();
  });
  return { columns, rows: source as RowStream['rows'], destroy };
}

function fromRows(columns: string[], rows: Row[]): FakeStream {
  return makeStream(columns, Readable.from(rows));
}

function fakeClient(factory: () => FakeStream | Promise<FakeStream>) {
  const streams: FakeStream[] = [];
  const openRowStream = jest.fn(async () => {
    const s = await factory();
    streams.push(s);
    return s;
  });
  return { client: { openRowStream } as RowStreamSource & { openRowStream: jest.Mock }, streams, openRowStream };
}

function ok(r: ExportResult) {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.error}`);
  return r;
}

describe('CsvExportService', () => {
  let parent: string;
  let root: string;
  let config: ExportConfig;

  beforeEach(() => {
    parent = mkdtempSync(path.join(tmpdir(), 'nlsql-exp-'));
    root = path.join(parent, 'downloads');
    mkdirSync(root);
    config = { rootDir: root, baseUrl: 'https://files.example.com/downloads' };
  });
  afterEach(() => rmSync(parent, { recursive: true, force: true }));

  const ownerFiles = (owner: string) => readdirSync(path.join(root, owner)).sort();

  describe('happy path', () => {
    const columns = ['id', 'name', 'note'];
    const rows: Row[] = [
      { id: 1, name: 'Zoë', note: '=1+1' },
      { id: 2, name: 'Smith, John', note: 'line1\nline2' },
      { id: 3, name: 'say "hi"', note: null },
    ];

    it('writes a BOM+CRLF csv, a correct sidecar, and returns the URL', async () => {
      const { client, openRowStream, streams } = fakeClient(() => fromRows(columns, rows));
      const svc = new CsvExportService(client, config);

      const res = ok(await svc.export({ ownerId: '254712345678', sql: 'SELECT id FROM t', question: 'Top 5 customers!' }));

      expect(openRowStream).toHaveBeenCalledWith('SELECT id FROM t', { timeoutMs: 60_000 });
      expect(res.rowCount).toBe(3);
      expect(res.columns).toEqual(columns);
      expect(res.truncated).toBe(false);
      expect(res.truncatedReason).toBeUndefined();
      expect(res.fileName).toMatch(FILE_NAME_RE);
      expect(res.fileName).toContain('_top-5-customers_');
      expect(res.relativePath).toBe(`254712345678/${res.fileName}.csv`);
      expect(res.url).toBe(`https://files.example.com/downloads/254712345678/${res.fileName}.csv`);

      // CSV bytes
      const csvPath = path.join(root, '254712345678', `${res.fileName}.csv`);
      const buf = readFileSync(csvPath);
      expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = buf.toString('utf8');
      expect(text.startsWith('\ufeffid,name,note\r\n')).toBe(true);
      expect(text.endsWith('\r\n')).toBe(true);
      expect(text).not.toMatch(/[^\r]\n(?!l)/); // only the embedded "line1\nline2" LF is bare

      const parsed = parse(text, { bom: true }) as string[][];
      expect(parsed).toEqual([
        ['id', 'name', 'note'],
        ['1', 'Zoë', "'=1+1"],
        ['2', 'Smith, John', 'line1\nline2'],
        ['3', 'say "hi"', ''],
      ]);
      expect(res.bytes).toBe(buf.length);

      // Sidecar
      const sidecarText = readFileSync(path.join(root, '254712345678', `${res.fileName}.json`), 'utf8');
      const sidecar = JSON.parse(sidecarText);
      const token = res.fileName.slice(-32);
      expect(sidecar).toEqual({
        version: 1,
        id: token,
        ownerId: '254712345678',
        fileName: `${res.fileName}.csv`,
        createdAt: expect.any(String),
        expiresAt: res.expiresAt,
        rowCount: 3,
        columns,
        truncated: false,
        truncatedReason: null,
        bytes: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
        question: 'Top 5 customers!',
      });
      expect(Date.parse(sidecar.expiresAt) - Date.parse(sidecar.createdAt)).toBe(24 * 3_600_000);
      expect(sidecarText).not.toContain('SELECT'); // SQL is never stored

      // Modes and leftovers
      expect(statSync(csvPath).mode & 0o777).toBe(0o640);
      expect(statSync(path.join(root, '254712345678', `${res.fileName}.json`)).mode & 0o777).toBe(0o640);
      expect(statSync(path.join(root, '254712345678')).mode & 0o777).toBe(0o750);
      expect(ownerFiles('254712345678').filter((f) => f.startsWith('.tmp-'))).toEqual([]);
      expect(ownerFiles('254712345678')).toHaveLength(2);

      // Stream always destroyed
      expect(streams[0]!.destroy).toHaveBeenCalled();
    });

    it('honours ttlHours, custom modes and a custom timeout', async () => {
      const { client, openRowStream } = fakeClient(() => fromRows(columns, rows));
      const svc = new CsvExportService(client, { ...config, ttlHours: 2, fileMode: 0o600, dirMode: 0o700, timeoutMs: 12_345 });

      const res = ok(await svc.export({ ownerId: 'alice', sql: 'SELECT 1' }));

      expect(openRowStream).toHaveBeenCalledWith('SELECT 1', { timeoutMs: 12_345 });
      expect(res.fileName).toContain('_export_'); // slug fallback with no question
      const created = Date.parse(JSON.parse(readFileSync(path.join(root, 'alice', `${res.fileName}.json`), 'utf8')).createdAt);
      expect(Date.parse(res.expiresAt) - created).toBe(2 * 3_600_000);
      expect(statSync(path.join(root, 'alice', `${res.fileName}.csv`)).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(root, 'alice')).mode & 0o777).toBe(0o700);
    });

    it('guards header names too', async () => {
      const { client } = fakeClient(() => fromRows(['=cmd', 'ok'], [{ '=cmd': 'a', ok: 'b' }]));
      const svc = new CsvExportService(client, config);
      const res = ok(await svc.export({ ownerId: 'alice', sql: 'SELECT 1' }));
      const text = readFileSync(path.join(root, 'alice', `${res.fileName}.csv`), 'utf8');
      expect(text.split('\r\n')[0]).toBe("\ufeff'=cmd,ok");
    });

    it('url-encodes the owner id and file name segments', async () => {
      const { client } = fakeClient(() => fromRows(['a'], [{ a: 1 }]));
      const svc = new CsvExportService(client, { ...config, baseUrl: 'http://localhost:3000/dl' });
      const res = ok(await svc.export({ ownerId: 'a_b-c', sql: 'SELECT 1' }));
      expect(res.url).toBe(`http://localhost:3000/dl/a_b-c/${res.fileName}.csv`);
    });
  });

  describe('truncation', () => {
    it('stops at maxRows, reports truncated/rows and destroys the source', async () => {
      const many = Array.from({ length: 50 }, (_, i) => ({ id: i }));
      const { client, streams } = fakeClient(() => fromRows(['id'], many));
      const svc = new CsvExportService(client, { ...config, maxRows: 10 });

      const res = ok(await svc.export({ ownerId: 'alice', sql: 'SELECT 1' }));

      expect(res.rowCount).toBe(10);
      expect(res.truncated).toBe(true);
      expect(res.truncatedReason).toBe('rows');
      expect(streams[0]!.destroy).toHaveBeenCalled();
      expect((streams[0]!.rows as unknown as Readable).destroyed).toBe(true);

      const sidecar = JSON.parse(readFileSync(path.join(root, 'alice', `${res.fileName}.json`), 'utf8'));
      expect(sidecar.truncated).toBe(true);
      expect(sidecar.truncatedReason).toBe('rows');
      const parsed = parse(readFileSync(path.join(root, 'alice', `${res.fileName}.csv`)), { bom: true }) as string[][];
      expect(parsed).toHaveLength(11); // header + 10
    });

    it('a result with exactly maxRows rows is NOT reported as truncated', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
      const { client } = fakeClient(() => fromRows(['id'], rows));
      const svc = new CsvExportService(client, { ...config, maxRows: 10 });

      const res = ok(await svc.export({ ownerId: 'alice', sql: 'SELECT 1' }));
      expect(res.rowCount).toBe(10);
      expect(res.truncated).toBe(false);
    });

    it('stops once maxBytes has been passed and reports truncated/bytes', async () => {
      const big = Array.from({ length: 5000 }, (_, i) => ({ id: i, v: 'x'.repeat(100) }));
      const { client, streams } = fakeClient(() => fromRows(['id', 'v'], big));
      const svc = new CsvExportService(client, { ...config, maxBytes: 2000 });

      const res = ok(await svc.export({ ownerId: 'alice', sql: 'SELECT 1' }));

      expect(res.truncated).toBe(true);
      expect(res.truncatedReason).toBe('bytes');
      expect(res.rowCount).toBeLessThan(5000);
      expect(res.rowCount).toBeGreaterThan(0);
      expect(streams[0]!.destroy).toHaveBeenCalled();
    });
  });

  describe('failure modes', () => {
    it('EMPTY: no rows -> no csv and no sidecar left behind', async () => {
      const { client, streams } = fakeClient(() => fromRows(['id'], []));
      const svc = new CsvExportService(client, config);

      const res = await svc.export({ ownerId: 'alice', sql: 'SELECT 1' });

      expect(res).toEqual({ ok: false, code: 'EMPTY', error: 'No rows to export.' });
      expect(ownerFiles('alice')).toEqual([]);
      expect(streams[0]!.destroy).toHaveBeenCalled();
    });

    it.each([
      ['../x'], ['a/b'], ['a\\b'], ['.'], ['..'], [''], ['a'.repeat(65)], ['_lead'], ['-lead'], ['x\0y'], ['é'], ['a b'], ['2547...@c.us'],
    ])('BAD_OWNER for %j, and nothing is written', async (ownerId) => {
      const { client, openRowStream } = fakeClient(() => fromRows(['id'], [{ id: 1 }]));
      const svc = new CsvExportService(client, config);

      const res = await svc.export({ ownerId, sql: 'SELECT 1' });

      expect(res).toMatchObject({ ok: false, code: 'BAD_OWNER' });
      expect(openRowStream).not.toHaveBeenCalled();
      expect(readdirSync(root)).toEqual([]);
      expect(readdirSync(parent)).toEqual(['downloads']);
    });

    it('accepts a 64-character owner id', async () => {
      const { client } = fakeClient(() => fromRows(['id'], [{ id: 1 }]));
      const svc = new CsvExportService(client, config);
      expect((await svc.export({ ownerId: 'a'.repeat(64), sql: 'SELECT 1' })).ok).toBe(true);
    });

    it('refuses a symlinked owner directory and writes nothing through it', async () => {
      const outside = mkdtempSync(path.join(tmpdir(), 'nlsql-outside-'));
      try {
        symlinkSync(outside, path.join(root, 'mallory'));
        const { client, openRowStream } = fakeClient(() => fromRows(['id'], [{ id: 1 }]));
        const svc = new CsvExportService(client, config);

        const res = await svc.export({ ownerId: 'mallory', sql: 'SELECT 1' });

        expect(res).toMatchObject({ ok: false, code: 'IO_ERROR' });
        expect(readdirSync(outside)).toEqual([]);
        expect(openRowStream).not.toHaveBeenCalled();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('REJECTED when the client rejects the SQL', async () => {
      const openRowStream = jest.fn().mockRejectedValue(new SqlRejectedError('single statement only', 'forbidden'));
      const svc = new CsvExportService({ openRowStream }, config);

      const res = await svc.export({ ownerId: 'alice', sql: 'SELECT 1; DROP TABLE t' });

      expect(res).toEqual({ ok: false, code: 'REJECTED', error: 'single statement only' });
      expect(ownerFiles('alice')).toEqual([]);
    });

    it('DB_ERROR when opening the stream fails', async () => {
      const openRowStream = jest.fn().mockRejectedValue(new Error('connection refused'));
      const svc = new CsvExportService({ openRowStream }, config);
      const res = await svc.export({ ownerId: 'alice', sql: 'SELECT 1' });
      expect(res).toMatchObject({ ok: false, code: 'DB_ERROR' });
    });

    it('TIMEOUT when opening the stream hits a database timeout', async () => {
      const err = Object.assign(new Error('Query execution was interrupted'), { errno: 3024 });
      const svc = new CsvExportService({ openRowStream: jest.fn().mockRejectedValue(err) }, config);
      const res = await svc.export({ ownerId: 'alice', sql: 'SELECT 1' });
      expect(res).toMatchObject({ ok: false, code: 'TIMEOUT' });
    });

    it('TIMEOUT: a source that never ends is aborted and temp files are removed', async () => {
      const { client, streams } = fakeClient(() => {
        const never = new Readable({ objectMode: true, read() {} });
        never.push({ id: 1 }); // one row, then silence
        return makeStream(['id'], never);
      });
      const svc = new CsvExportService(client, { ...config, timeoutMs: 300 });

      const started = Date.now();
      const res = await svc.export({ ownerId: 'alice', sql: 'SELECT 1' });

      expect(res).toMatchObject({ ok: false, code: 'TIMEOUT' });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(ownerFiles('alice')).toEqual([]);
      expect(streams[0]!.destroy).toHaveBeenCalled();
    });

    it('DB_ERROR: an error mid-stream removes temp files', async () => {
      const { client, streams } = fakeClient(() => {
        const src = new Readable({ objectMode: true, read() {} });
        src.push({ id: 1 });
        src.push({ id: 2 });
        setTimeout(() => src.destroy(new Error('Lost connection to MySQL server')), 20);
        return makeStream(['id'], src);
      });
      const svc = new CsvExportService(client, config);

      const res = await svc.export({ ownerId: 'alice', sql: 'SELECT 1' });

      expect(res).toMatchObject({ ok: false, code: 'DB_ERROR', error: expect.stringContaining('Lost connection') });
      expect(ownerFiles('alice')).toEqual([]);
      expect(streams[0]!.destroy).toHaveBeenCalled();
    });

    it('IO_ERROR and no orphan csv when the sidecar cannot be written', async () => {
      // Force a failure in the commit phase: once the stream has been fully consumed (the
      // generator destroys it after the last row) the temp csv is already written, so make
      // the owner directory read-only. rename() then fails with EACCES.
      const { chmodSync } = await import('fs');
      const ownerDir = path.join(root, 'alice');
      mkdirSync(ownerDir);

      const { client } = fakeClient(() => {
        const src = new Readable({ objectMode: true, read() {} });
        src.push({ id: 1 });
        src.push(null);
        const s = makeStream(['id'], src);
        // The service destroys the stream in generator cleanup right after the last row.
        // By then the temp csv exists; freeze the directory so the commit's rename fails.
        const orig = s.destroy;
        s.destroy = jest.fn(async () => {
          chmodSync(ownerDir, 0o500);
          await orig();
        });
        return s;
      });
      const svc = new CsvExportService(client, config);

      let res: ExportResult;
      try {
        res = await svc.export({ ownerId: 'alice', sql: 'SELECT 1' });
      } finally {
        chmodSync(ownerDir, 0o700);
      }

      if (process.getuid && process.getuid() === 0) return; // root ignores directory modes
      expect(res).toMatchObject({ ok: false });
      // Whatever happened, no csv may exist without a sidecar.
      const files = readdirSync(ownerDir);
      const csvs = files.filter((f) => f.endsWith('.csv') && !f.startsWith('.tmp-'));
      const sidecars = files.filter((f) => f.endsWith('.json') && !f.startsWith('.tmp-'));
      expect(csvs.length).toBe(sidecars.length);
    });
  });

  describe('quotas', () => {
    const exportOnce = async (svc: CsvExportService, q: string) => {
      const res = ok(await svc.export({ ownerId: 'alice', sql: 'SELECT 1', question: q }));
      await new Promise((r) => setTimeout(r, 5)); // distinct createdAt
      return res;
    };

    it('maxFilesPerOwner evicts the oldest; the new file is kept', async () => {
      const { client } = fakeClient(() => fromRows(['id'], [{ id: 1 }]));
      const svc = new CsvExportService(client, { ...config, maxFilesPerOwner: 2 });

      const first = await exportOnce(svc, 'one');
      const second = await exportOnce(svc, 'two');
      const third = await exportOnce(svc, 'three');

      const files = ownerFiles('alice');
      expect(files).toHaveLength(4); // two exports x (csv + json)
      expect(files).not.toContain(`${first.fileName}.csv`);
      expect(files).not.toContain(`${first.fileName}.json`);
      expect(files).toContain(`${second.fileName}.csv`);
      expect(files).toContain(`${third.fileName}.csv`);
      expect(files).toContain(`${third.fileName}.json`);
    });

    it('maxBytesPerOwner evicts older exports but never the one just written', async () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({ id: i, v: 'x'.repeat(50) }));
      const { client } = fakeClient(() => fromRows(['id', 'v'], rows));
      const svc = new CsvExportService(client, { ...config, maxBytesPerOwner: 1 }); // smaller than any single export

      const first = await exportOnce(svc, 'one');
      const second = await exportOnce(svc, 'two');

      const files = ownerFiles('alice');
      expect(files).toEqual([`${second.fileName}.csv`, `${second.fileName}.json`]);
      expect(files).not.toContain(`${first.fileName}.csv`);
    });

    it('quotas are per owner', async () => {
      const { client } = fakeClient(() => fromRows(['id'], [{ id: 1 }]));
      const svc = new CsvExportService(client, { ...config, maxFilesPerOwner: 1 });

      const a = ok(await svc.export({ ownerId: 'alice', sql: 'SELECT 1' }));
      const b = ok(await svc.export({ ownerId: 'bob', sql: 'SELECT 1' }));

      expect(existsSync(path.join(root, 'alice', `${a.fileName}.csv`))).toBe(true);
      expect(existsSync(path.join(root, 'bob', `${b.fileName}.csv`))).toBe(true);
    });
  });

  describe('mutex', () => {
    it('runs two concurrent exports one after the other', async () => {
      const events: string[] = [];
      let active = 0;
      let maxActive = 0;
      let n = 0;

      const openRowStream = jest.fn(async () => {
        const id = ++n;
        active++;
        maxActive = Math.max(maxActive, active);
        events.push(`open${id}`);
        const src = new Readable({ objectMode: true, read() {} });
        setTimeout(() => {
          src.push({ id });
          src.push(null);
        }, 60);
        const s = makeStream(['id'], src);
        const origDestroy = s.destroy;
        s.destroy = jest.fn(async () => {
          if (!events.includes(`close${id}`)) {
            events.push(`close${id}`);
            active--;
          }
          await origDestroy();
        });
        return s;
      });

      const svc = new CsvExportService({ openRowStream }, config);
      const [r1, r2] = await Promise.all([
        svc.export({ ownerId: 'alice', sql: 'SELECT 1' }),
        svc.export({ ownerId: 'bob', sql: 'SELECT 1' }),
      ]);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(maxActive).toBe(1);
      expect(events).toEqual(['open1', 'close1', 'open2', 'close2']);
    });

    it('a failing export does not block the queue', async () => {
      let call = 0;
      const openRowStream = jest.fn(async () => {
        call++;
        if (call === 1) throw new Error('boom');
        return fromRows(['id'], [{ id: 1 }]);
      });
      const svc = new CsvExportService({ openRowStream }, config);

      const [r1, r2] = await Promise.all([
        svc.export({ ownerId: 'alice', sql: 'SELECT 1' }),
        svc.export({ ownerId: 'alice', sql: 'SELECT 1' }),
      ]);

      expect(r1).toMatchObject({ ok: false, code: 'DB_ERROR' });
      expect(r2.ok).toBe(true);
    });
  });
});
