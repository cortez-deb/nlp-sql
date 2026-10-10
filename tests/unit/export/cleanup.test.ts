/**
 * tests/unit/export/cleanup.test.ts
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, utimesSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { cleanupExpired, startCleanupTimer, enforceFileCountQuota, enforceByteQuota } from '../../../src/export/cleanup';

const HOUR = 3_600_000;
const NOW = new Date('2026-10-10T12:00:00.000Z');

let seq = 0;
function fname(tsMs = NOW.getTime()): string {
  const d = new Date(tsMs);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  seq++;
  return `${stamp}_test_${seq.toString(16).padStart(32, '0')}`;
}

function setAge(file: string, ageMs: number) {
  const t = new Date(NOW.getTime() - ageMs);
  utimesSync(file, t, t);
}

function makeExport(
  ownerDir: string,
  opts: { createdAtMs?: number; expiresAtMs: number; csvBytes?: number }
): string {
  mkdirSync(ownerDir, { recursive: true });
  const name = fname(opts.createdAtMs);
  writeFileSync(path.join(ownerDir, `${name}.csv`), 'x'.repeat(opts.csvBytes ?? 10));
  writeFileSync(
    path.join(ownerDir, `${name}.json`),
    JSON.stringify({
      createdAt: new Date(opts.createdAtMs ?? NOW.getTime()).toISOString(),
      expiresAt: new Date(opts.expiresAtMs).toISOString(),
    })
  );
  return name;
}

describe('export cleanup', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'nlsql-clean-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('removes expired exports (csv and sidecar) and keeps fresh ones', async () => {
    const owner = path.join(root, '254700000001');
    const expired = makeExport(owner, { expiresAtMs: NOW.getTime() - 1000 });
    const fresh = makeExport(owner, { expiresAtMs: NOW.getTime() + HOUR });

    const res = await cleanupExpired({ rootDir: root }, NOW);

    expect(res.deleted).toBe(1);
    expect(existsSync(path.join(owner, `${expired}.csv`))).toBe(false);
    expect(existsSync(path.join(owner, `${expired}.json`))).toBe(false);
    expect(existsSync(path.join(owner, `${fresh}.csv`))).toBe(true);
    expect(existsSync(path.join(owner, `${fresh}.json`))).toBe(true);
  });

  it('removes an expired sidecar even when its csv is already gone', async () => {
    const owner = path.join(root, 'alice');
    const name = makeExport(owner, { expiresAtMs: NOW.getTime() - 1000 });
    rmSync(path.join(owner, `${name}.csv`));

    await cleanupExpired({ rootDir: root }, NOW);
    expect(existsSync(path.join(owner, `${name}.json`))).toBe(false);
  });

  it('never touches foreign files, off-pattern names or non-owner directories', async () => {
    const owner = path.join(root, 'alice');
    mkdirSync(owner);
    const foreign = ['notes.txt', 'expired.csv', 'expired.json', '.hidden', 'backup.tmp', '20200101-000000_ok_short.csv', '.tmp-short.csv'];
    for (const f of foreign) {
      writeFileSync(path.join(owner, f), 'keep');
      setAge(path.join(owner, f), 10 * 24 * HOUR);
    }
    // directory names that are not valid owner ids
    const badDir = path.join(root, '.bad dir');
    mkdirSync(badDir);
    writeFileSync(path.join(badDir, `${fname()}.csv`), 'keep');
    setAge(path.join(badDir, readdirSync(badDir)[0]!), 10 * 24 * HOUR);
    // nested directory inside an owner dir is never recursed
    mkdirSync(path.join(owner, 'sub'));
    writeFileSync(path.join(owner, 'sub', `${fname()}.csv`), 'keep');
    setAge(path.join(owner, 'sub', readdirSync(path.join(owner, 'sub'))[0]!), 10 * 24 * HOUR);
    // a loose file in the root
    writeFileSync(path.join(root, 'root-file.txt'), 'keep');

    const res = await cleanupExpired({ rootDir: root }, NOW);

    expect(res.deleted).toBe(0);
    for (const f of foreign) expect(existsSync(path.join(owner, f))).toBe(true);
    expect(readdirSync(badDir)).toHaveLength(1);
    expect(readdirSync(path.join(owner, 'sub'))).toHaveLength(1);
    expect(existsSync(path.join(root, 'root-file.txt'))).toBe(true);
  });

  it('skips symlinked owner directories', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'nlsql-outside-'));
    try {
      const name = makeExport(outside, { expiresAtMs: NOW.getTime() - 1000 });
      symlinkSync(outside, path.join(root, 'mallory'));

      const res = await cleanupExpired({ rootDir: root }, NOW);

      expect(res.deleted).toBe(0);
      expect(existsSync(path.join(outside, `${name}.csv`))).toBe(true);
      expect(existsSync(path.join(outside, `${name}.json`))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('removes orphan temp files and sidecar-less csv files older than 1 hour, keeps recent ones', async () => {
    const owner = path.join(root, 'alice');
    mkdirSync(owner);
    const token = 'a'.repeat(32);
    const oldTmp = path.join(owner, `.tmp-${token}.csv`);
    const oldTmpJson = path.join(owner, `.tmp-${token}.json`);
    const recentTmp = path.join(owner, `.tmp-${'b'.repeat(32)}.csv`);
    const oldOrphan = path.join(owner, `${fname()}.csv`);
    const recentOrphan = path.join(owner, `${fname()}.csv`);
    for (const f of [oldTmp, oldTmpJson, recentTmp, oldOrphan, recentOrphan]) writeFileSync(f, 'x');
    setAge(oldTmp, 2 * HOUR);
    setAge(oldTmpJson, 2 * HOUR);
    setAge(oldOrphan, 2 * HOUR);
    setAge(recentTmp, 10 * 60_000);
    setAge(recentOrphan, 10 * 60_000);

    const res = await cleanupExpired({ rootDir: root }, NOW);

    expect(res.deleted).toBe(3);
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(oldTmpJson)).toBe(false);
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(recentTmp)).toBe(true);
    expect(existsSync(recentOrphan)).toBe(true);
  });

  it('a csv that has a sidecar is not treated as an orphan', async () => {
    const owner = path.join(root, 'alice');
    const name = makeExport(owner, { expiresAtMs: NOW.getTime() + HOUR });
    setAge(path.join(owner, `${name}.csv`), 5 * HOUR);

    const res = await cleanupExpired({ rootDir: root }, NOW);
    expect(res.deleted).toBe(0);
    expect(existsSync(path.join(owner, `${name}.csv`))).toBe(true);
  });

  it('falls back to file age + ttl for a corrupt sidecar', async () => {
    const owner = path.join(root, 'alice');
    mkdirSync(owner);
    const name = fname();
    writeFileSync(path.join(owner, `${name}.csv`), 'x');
    writeFileSync(path.join(owner, `${name}.json`), '{not json');
    setAge(path.join(owner, `${name}.json`), 30 * HOUR);

    const res = await cleanupExpired({ rootDir: root, ttlHours: 24 }, NOW);
    expect(res.deleted).toBe(1);
    expect(existsSync(path.join(owner, `${name}.csv`))).toBe(false);
  });

  it('startCleanupTimer runs once at startup and can be stopped', async () => {
    const owner = path.join(root, 'alice');
    const name = makeExport(owner, { expiresAtMs: Date.now() - 1000 });
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    const timer = startCleanupTimer({ rootDir: root }, 3_600_000);
    await new Promise((r) => setTimeout(r, 100));
    timer.stop();

    expect(existsSync(path.join(owner, `${name}.csv`))).toBe(false);
    // counts, not file names
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/removed 1 item/));
    expect(JSON.stringify(info.mock.calls)).not.toContain(name);
    info.mockRestore();
  });
});

describe('export quotas', () => {
  let root: string;
  let owner: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'nlsql-quota-'));
    owner = path.join(root, 'alice');
    mkdirSync(owner);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('file-count quota deletes the oldest (by createdAt) until there is room for one more', async () => {
    const t = NOW.getTime();
    const oldest = makeExport(owner, { createdAtMs: t - 3 * HOUR, expiresAtMs: t + HOUR });
    const middle = makeExport(owner, { createdAtMs: t - 2 * HOUR, expiresAtMs: t + HOUR });
    const newest = makeExport(owner, { createdAtMs: t - HOUR, expiresAtMs: t + HOUR });

    const deleted = await enforceFileCountQuota(owner, 3);

    expect(deleted).toBe(1);
    expect(existsSync(path.join(owner, `${oldest}.json`))).toBe(false);
    expect(existsSync(path.join(owner, `${oldest}.csv`))).toBe(false);
    expect(existsSync(path.join(owner, `${middle}.json`))).toBe(true);
    expect(existsSync(path.join(owner, `${newest}.json`))).toBe(true);
  });

  it('byte quota deletes the oldest others, never the file just written', async () => {
    const t = NOW.getTime();
    const a = makeExport(owner, { createdAtMs: t - 3 * HOUR, expiresAtMs: t + HOUR, csvBytes: 400 });
    const b = makeExport(owner, { createdAtMs: t - 2 * HOUR, expiresAtMs: t + HOUR, csvBytes: 400 });
    // The "new" file is the oldest by timestamp and alone exceeds the quota.
    const keep = makeExport(owner, { createdAtMs: t - 9 * HOUR, expiresAtMs: t + HOUR, csvBytes: 5000 });

    const deleted = await enforceByteQuota(owner, 1000, keep);

    expect(deleted).toBe(2);
    expect(existsSync(path.join(owner, `${a}.csv`))).toBe(false);
    expect(existsSync(path.join(owner, `${b}.csv`))).toBe(false);
    expect(existsSync(path.join(owner, `${keep}.csv`))).toBe(true);
    expect(existsSync(path.join(owner, `${keep}.json`))).toBe(true);
  });

  it('byte quota stops as soon as the total fits', async () => {
    const t = NOW.getTime();
    const a = makeExport(owner, { createdAtMs: t - 3 * HOUR, expiresAtMs: t + HOUR, csvBytes: 400 });
    const b = makeExport(owner, { createdAtMs: t - 2 * HOUR, expiresAtMs: t + HOUR, csvBytes: 400 });
    const keep = makeExport(owner, { createdAtMs: t - HOUR, expiresAtMs: t + HOUR, csvBytes: 400 });

    // each export is ~400 + sidecar (~90) bytes; 1100 fits two but not three
    await enforceByteQuota(owner, 1100, keep);

    expect(existsSync(path.join(owner, `${a}.csv`))).toBe(false);
    expect(existsSync(path.join(owner, `${b}.csv`))).toBe(true);
    expect(existsSync(path.join(owner, `${keep}.csv`))).toBe(true);
  });
});
