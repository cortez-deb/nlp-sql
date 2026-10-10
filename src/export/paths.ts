/**
 * export/paths.ts
 *
 * Owner ids, file names and path safety. Path traversal is the main risk of
 * this module: every path is checked to stay inside the export root.
 */

import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

export const OWNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const FILE_NAME_RE = /^\d{8}-\d{6}_[a-z0-9-]{1,40}_[0-9a-f]{32}$/;
export const TMP_NAME_RE = /^\.tmp-[0-9a-f]{32}\.(csv|json)$/;

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSafetyError';
    Object.setPrototypeOf(this, PathSafetyError.prototype);
  }
}

export function isValidOwnerId(ownerId: unknown): ownerId is string {
  return typeof ownerId === 'string' && OWNER_ID_RE.test(ownerId);
}

export function slugify(question: string | undefined): string {
  const slug = (question ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'export';
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** UTC yyyyMMdd-HHmmss */
export function formatTimestamp(d: Date): string {
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

export function newToken(): string {
  return randomBytes(16).toString('hex');
}

/** `<UTCyyyyMMdd-HHmmss>_<slug>_<token>` (no extension). */
export function buildFileName(
  question: string | undefined,
  now: Date = new Date(),
  token: string = newToken()
): { fileName: string; token: string } {
  const fileName = `${formatTimestamp(now)}_${slugify(question)}_${token}`;
  return { fileName, token };
}

/** Returns the token part of a valid file name, or null. */
export function tokenOf(fileName: string): string | null {
  return FILE_NAME_RE.test(fileName) ? fileName.slice(-32) : null;
}

/** Resolve `parts` under `rootDir` and assert the result stays inside it. */
export function resolveInside(rootDir: string, ...parts: string[]): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, ...parts);
  if (!resolved.startsWith(root + path.sep)) {
    throw new PathSafetyError('Resolved path escapes the export root');
  }
  return resolved;
}

/**
 * Ensure `<rootDir>/<ownerId>` exists as a real directory (never a symlink)
 * and return its absolute path.
 */
export async function ensureOwnerDir(
  rootDir: string,
  ownerId: string,
  dirMode: number
): Promise<string> {
  if (!isValidOwnerId(ownerId)) {
    throw new PathSafetyError('Invalid ownerId');
  }
  const ownerDir = resolveInside(rootDir, ownerId);

  let created = false;
  try {
    await fs.lstat(ownerDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await fs.mkdir(ownerDir, { recursive: true, mode: dirMode });
    created = true;
  }

  // Check after any mkdir too, in case something raced us.
  const st = await fs.lstat(ownerDir);
  if (st.isSymbolicLink()) throw new PathSafetyError('Owner directory is a symlink');
  if (!st.isDirectory()) throw new PathSafetyError('Owner path is not a directory');

  if (created) {
    // mkdir's mode is masked by umask; set it explicitly.
    await fs.chmod(ownerDir, dirMode);
  }
  return ownerDir;
}
