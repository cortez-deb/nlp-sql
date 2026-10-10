/**
 * tests/unit/export/config.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { loadExportConfigFromEnv } from '../../../src/export/config';

describe('loadExportConfigFromEnv', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nlsql-cfg-'));
  });
  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string | undefined> = {}) => ({
    EXPORT_BASE_URL: 'https://files.example.com/downloads/',
    EXPORT_ROOT_DIR: dir,
    ...extra,
  });

  it('loads a valid config, strips the trailing slash and leaves unset numbers undefined', () => {
    const cfg = loadExportConfigFromEnv(env());
    expect(cfg).toEqual({ rootDir: dir, baseUrl: 'https://files.example.com/downloads' });
  });

  it('parses numeric options (MB converted to bytes)', () => {
    const cfg = loadExportConfigFromEnv(
      env({
        EXPORT_TTL_HOURS: '48',
        EXPORT_MAX_ROWS: '5000',
        EXPORT_MAX_MB: '10',
        EXPORT_TIMEOUT_MS: '30000',
      })
    );
    expect(cfg.ttlHours).toBe(48);
    expect(cfg.maxRows).toBe(5000);
    expect(cfg.maxBytes).toBe(10 * 1024 * 1024);
    expect(cfg.timeoutMs).toBe(30000);
  });

  it('requires EXPORT_BASE_URL', () => {
    expect(() => loadExportConfigFromEnv(env({ EXPORT_BASE_URL: undefined }))).toThrow(/EXPORT_BASE_URL is required/);
    expect(() => loadExportConfigFromEnv(env({ EXPORT_BASE_URL: '  ' }))).toThrow(/EXPORT_BASE_URL is required/);
  });

  it('requires https, except for localhost and 127.0.0.1', () => {
    expect(() => loadExportConfigFromEnv(env({ EXPORT_BASE_URL: 'http://files.example.com/d' }))).toThrow(/https/);
    expect(() => loadExportConfigFromEnv(env({ EXPORT_BASE_URL: 'ftp://x/d' }))).toThrow(/https/);
    expect(loadExportConfigFromEnv(env({ EXPORT_BASE_URL: 'http://localhost:3000/d/' })).baseUrl).toBe('http://localhost:3000/d');
    expect(loadExportConfigFromEnv(env({ EXPORT_BASE_URL: 'http://127.0.0.1:3000/d' })).baseUrl).toBe('http://127.0.0.1:3000/d');
  });

  it('rejects garbage URLs, credentials, queries and fragments', () => {
    expect(() => loadExportConfigFromEnv(env({ EXPORT_BASE_URL: 'not a url' }))).toThrow(/valid URL/);
    expect(() => loadExportConfigFromEnv(env({ EXPORT_BASE_URL: 'https://u:p@x.com/d' }))).toThrow(/credentials/);
    expect(() => loadExportConfigFromEnv(env({ EXPORT_BASE_URL: 'https://x.com/d?a=1' }))).toThrow(/query/);
  });

  it('rejects relative, missing, non-directory and unwritable root dirs', () => {
    expect(() => loadExportConfigFromEnv(env({ EXPORT_ROOT_DIR: 'relative/dir' }))).toThrow(/absolute/);
    expect(() => loadExportConfigFromEnv(env({ EXPORT_ROOT_DIR: path.join(dir, 'missing') }))).toThrow(/does not exist/);

    const file = path.join(dir, 'f.txt');
    writeFileSync(file, 'x');
    expect(() => loadExportConfigFromEnv(env({ EXPORT_ROOT_DIR: file }))).toThrow(/not a directory/);

    if (process.getuid && process.getuid() !== 0) {
      chmodSync(dir, 0o500);
      expect(() => loadExportConfigFromEnv(env())).toThrow(/not writable/);
    }
  });

  it.each(['0', '-5', '1.5', 'abc', '1e3'])('rejects non positive-integer number "%s"', (bad) => {
    expect(() => loadExportConfigFromEnv(env({ EXPORT_MAX_ROWS: bad }))).toThrow(/EXPORT_MAX_ROWS/);
  });

  it('defaults rootDir to /var/www/downloads (and validates it)', () => {
    try {
      const cfg = loadExportConfigFromEnv({ EXPORT_BASE_URL: 'https://x.com/d', EXPORT_ROOT_DIR: undefined });
      expect(cfg.rootDir).toBe('/var/www/downloads');
    } catch (err: any) {
      expect(err.message).toMatch(/\/var\/www\/downloads/);
    }
  });
});
