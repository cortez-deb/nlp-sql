/**
 * export/cleanup.ts
 *
 * Expiry cleanup, per-owner quotas, and the shared delete routine.
 *
 * Safety rules: only direct children of rootDir that match the owner-id regex
 * and are real directories (not symlinks) are scanned; only files matching the
 * exact name patterns are ever deleted; nothing is recursed deeper than owner
 * dirs; logs contain counts, never file names.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { EXPORT_DEFAULTS } from './types';
import type { ExportConfig, ExportSidecar } from './types';
import { FILE_NAME_RE, OWNER_ID_RE, TMP_NAME_RE } from './paths';

const ONE_HOUR_MS = 3_600_000;

type CleanupConfig = Pick<ExportConfig, 'rootDir' | 'ttlHours'>;

interface OwnerExport {
  fileName: string; // without extension
  createdAtMs: number;
  bytes: number; // csv + sidecar, as found on disk
}

async function lstatOrNull(p: string) {
  try {
    return await fs.lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function unlinkIfExists(p: string): Promise<boolean> {
  try {
    await fs.unlink(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function readSidecar(file: string): Promise<Partial<ExportSidecar> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Partial<ExportSidecar>) : null;
  } catch {
    return null;
  }
}

/** Delete one export: the .csv first, then the sidecar. */
export async function deleteExport(ownerDir: string, fileName: string): Promise<void> {
  if (!FILE_NAME_RE.test(fileName)) return; // never delete anything off-pattern
  await unlinkIfExists(path.join(ownerDir, `${fileName}.csv`));
  await unlinkIfExists(path.join(ownerDir, `${fileName}.json`));
}

/** Lists completed exports (those with a sidecar) in an owner directory. */
async function listOwnerExports(ownerDir: string): Promise<OwnerExport[]> {
  const names = await fs.readdir(ownerDir);
  const out: OwnerExport[] = [];

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const fileName = name.slice(0, -'.json'.length);
    if (!FILE_NAME_RE.test(fileName)) continue;

    const jsonStat = await lstatOrNull(path.join(ownerDir, name));
    if (!jsonStat || !jsonStat.isFile()) continue;

    const sidecar = await readSidecar(path.join(ownerDir, name));
    const parsedCreated = sidecar?.createdAt ? Date.parse(sidecar.createdAt) : NaN;
    const csvStat = await lstatOrNull(path.join(ownerDir, `${fileName}.csv`));

    out.push({
      fileName,
      createdAtMs: Number.isNaN(parsedCreated) ? jsonStat.mtimeMs : parsedCreated,
      bytes: jsonStat.size + (csvStat && csvStat.isFile() ? csvStat.size : 0),
    });
  }

  return out.sort((a, b) => a.createdAtMs - b.createdAtMs);
}

/**
 * Before writing: while the owner has >= maxFiles exports, delete the oldest.
 * Leaves room for one new export. Returns the number deleted.
 */
export async function enforceFileCountQuota(
  ownerDir: string,
  maxFiles: number
): Promise<number> {
  const exports = await listOwnerExports(ownerDir);
  let deleted = 0;
  while (exports.length >= Math.max(1, maxFiles)) {
    const oldest = exports.shift()!;
    await deleteExport(ownerDir, oldest.fileName);
    deleted++;
  }
  return deleted;
}

/**
 * After writing: while the owner's total bytes exceed maxBytes, delete the
 * oldest export other than `keepFileName`. Returns the number deleted.
 */
export async function enforceByteQuota(
  ownerDir: string,
  maxBytes: number,
  keepFileName: string
): Promise<number> {
  const exports = await listOwnerExports(ownerDir);
  let total = exports.reduce((n, e) => n + e.bytes, 0);
  let deleted = 0;

  for (const e of exports) {
    if (total <= maxBytes) break;
    if (e.fileName === keepFileName) continue;
    await deleteExport(ownerDir, e.fileName);
    total -= e.bytes;
    deleted++;
  }
  return deleted;
}

async function cleanOwnerDir(
  ownerDir: string,
  ttlMs: number,
  now: Date
): Promise<number> {
  const names = await fs.readdir(ownerDir);
  const nameSet = new Set(names);
  let deleted = 0;

  for (const name of names) {
    const full = path.join(ownerDir, name);

    // 1. Expired exports, keyed on the sidecar.
    if (name.endsWith('.json') && FILE_NAME_RE.test(name.slice(0, -5))) {
      const st = await lstatOrNull(full);
      if (!st || !st.isFile()) continue;

      const sidecar = await readSidecar(full);
      const parsedExpiry = sidecar?.expiresAt ? Date.parse(sidecar.expiresAt) : NaN;
      // A corrupt sidecar falls back to file age + ttl so it cannot live forever.
      const expiresAtMs = Number.isNaN(parsedExpiry) ? st.mtimeMs + ttlMs : parsedExpiry;

      if (expiresAtMs < now.getTime()) {
        await deleteExport(ownerDir, name.slice(0, -5));
        deleted++;
      }
      continue;
    }

    // 2. Leftover temp files older than 1 hour.
    if (TMP_NAME_RE.test(name)) {
      const st = await lstatOrNull(full);
      if (st && st.isFile() && now.getTime() - st.mtimeMs > ONE_HOUR_MS) {
        if (await unlinkIfExists(full)) deleted++;
      }
      continue;
    }

    // 3. CSV files with no sidecar older than 1 hour.
    if (name.endsWith('.csv') && FILE_NAME_RE.test(name.slice(0, -4))) {
      if (nameSet.has(`${name.slice(0, -4)}.json`)) continue;
      const st = await lstatOrNull(full);
      if (st && st.isFile() && now.getTime() - st.mtimeMs > ONE_HOUR_MS) {
        if (await unlinkIfExists(full)) deleted++;
      }
    }
  }

  return deleted;
}

export async function cleanupExpired(
  config: CleanupConfig,
  now: Date = new Date()
): Promise<{ deleted: number }> {
  const ttlMs = (config.ttlHours ?? EXPORT_DEFAULTS.ttlHours) * ONE_HOUR_MS;
  let deleted = 0;

  const entries = await fs.readdir(config.rootDir, { withFileTypes: true });
  for (const entry of entries) {
    // Dirent.isDirectory() is false for symlinks, so symlinked owner dirs are skipped.
    if (!entry.isDirectory() || !OWNER_ID_RE.test(entry.name)) continue;
    try {
      deleted += await cleanOwnerDir(path.join(config.rootDir, entry.name), ttlMs, now);
    } catch {
      // One unreadable owner dir must not stop the sweep.
    }
  }

  return { deleted };
}

export function startCleanupTimer(
  config: CleanupConfig,
  intervalMs = 3_600_000
): { stop(): void } {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { deleted } = await cleanupExpired(config);
      if (deleted > 0) console.info(`[nlsql] export cleanup removed ${deleted} item(s)`);
    } catch (err) {
      console.error(
        `[nlsql] export cleanup failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      running = false;
    }
  };

  void run(); // once at startup
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref(); // never keep the process alive

  return { stop: () => clearInterval(timer) };
}
