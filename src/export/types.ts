/**
 * export/types.ts
 */

import type { RowStream } from '../db/MySQLAdapter';

export interface ExportConfig {
  /** Absolute directory, e.g. /var/www/downloads */
  rootDir: string;
  /** e.g. https://files.example.com/downloads (no trailing slash) */
  baseUrl: string;
  /** Default 24 */
  ttlHours?: number;
  /** Default 100_000 */
  maxRows?: number;
  /** Default 50 * 1024 * 1024 */
  maxBytes?: number;
  /** Default 60_000 */
  timeoutMs?: number;
  /** Default 20 */
  maxFilesPerOwner?: number;
  /** Default 200 * 1024 * 1024 */
  maxBytesPerOwner?: number;
  /** Default 0o640 */
  fileMode?: number;
  /** Default 0o750 */
  dirMode?: number;
}

export interface ExportRequest {
  /** Matches ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$. Never a raw WhatsApp chat id. */
  ownerId: string;
  /** Last successful SQL for this chat, or the SQL from a fresh query(). */
  sql: string;
  /** Used for the file-name slug and stored in the sidecar. */
  question?: string;
}

export type ExportErrorCode =
  | 'EMPTY'
  | 'REJECTED'
  | 'TIMEOUT'
  | 'DB_ERROR'
  | 'IO_ERROR'
  | 'BAD_OWNER';

export type ExportResult =
  | {
      ok: true;
      url: string;
      fileName: string;
      relativePath: string;
      rowCount: number;
      columns: string[];
      truncated: boolean;
      truncatedReason?: 'rows' | 'bytes';
      bytes: number;
      expiresAt: string;
    }
  | { ok: false; code: ExportErrorCode; error: string };

/** The minimal slice of NLSQLClient the exporter depends on (easy to fake in tests). */
export interface RowStreamSource {
  openRowStream(sql: string, opts?: { timeoutMs?: number }): Promise<RowStream>;
}

/** Contents of `<fileName>.json`, the contract with the web app. */
export interface ExportSidecar {
  version: 1;
  id: string;
  ownerId: string;
  /** Includes the .csv extension. */
  fileName: string;
  createdAt: string;
  expiresAt: string;
  rowCount: number;
  columns: string[];
  truncated: boolean;
  truncatedReason: 'rows' | 'bytes' | null;
  bytes: number;
  sha256: string;
  question: string | null;
}

export const EXPORT_DEFAULTS = {
  ttlHours: 24,
  maxRows: 100_000,
  maxBytes: 50 * 1024 * 1024,
  timeoutMs: 60_000,
  maxFilesPerOwner: 20,
  maxBytesPerOwner: 200 * 1024 * 1024,
  fileMode: 0o640,
  dirMode: 0o750,
} as const;
