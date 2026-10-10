/**
 * export/CsvExportService.ts
 *
 * Re-executes a query as a stream and writes it to
 *   <rootDir>/<ownerId>/<fileName>.csv  (+ <fileName>.json sidecar)
 * then returns a download URL. Framework independent: the (separate) web app
 * serves the files, the bot just calls export().
 */

import { createHash } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import * as path from 'path';
import { Readable, Transform } from 'stream';
import type { TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { stringify } from 'csv-stringify';

import { SqlRejectedError } from '../core/errors';
import type { RowStream } from '../db/MySQLAdapter';
import { csvCell } from './csvCell';
import { enforceByteQuota, enforceFileCountQuota } from './cleanup';
import {
  PathSafetyError,
  buildFileName,
  ensureOwnerDir,
  isValidOwnerId,
  resolveInside,
} from './paths';
import { EXPORT_DEFAULTS } from './types';
import type {
  ExportConfig,
  ExportRequest,
  ExportResult,
  ExportSidecar,
  RowStreamSource,
} from './types';

const MAX_QUESTION_CHARS = 500;

/** Passes bytes through unchanged while counting them and updating a SHA-256. */
class ByteCounter extends Transform {
  bytes = 0;
  private readonly hash = createHash('sha256');

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    this.hash.update(chunk);
    cb(null, chunk);
  }

  digest(): string {
    return this.hash.digest('hex');
  }
}

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: unknown; errno?: unknown; message?: string };
  return (
    e.name === 'AbortError' ||
    e.name === 'TimeoutError' ||
    e.code === 'PROTOCOL_SEQUENCE_TIMEOUT' ||
    e.code === 'ER_QUERY_TIMEOUT' ||
    e.code === 'ABORT_ERR' ||
    e.errno === 3024 || // MySQL: MAX_EXECUTION_TIME exceeded
    e.errno === 1969 || // MariaDB: max_statement_time exceeded
    /timed out waiting for the query/i.test(e.message ?? '')
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function unlinkQuiet(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    // already gone, or not ours to worry about
  }
}

export class CsvExportService {
  private readonly client: RowStreamSource;
  private readonly config: ExportConfig;
  /** Tail of the in-memory queue that serialises exports (one at a time). */
  private tail: Promise<void> = Promise.resolve();

  constructor(client: RowStreamSource, config: ExportConfig) {
    this.client = client;
    this.config = config;
  }

  async export(req: ExportRequest): Promise<ExportResult> {
    // 1. Validate ownerId before touching anything.
    if (!isValidOwnerId(req.ownerId)) {
      return { ok: false, code: 'BAD_OWNER', error: 'Invalid owner id.' };
    }

    // 2. Global export mutex.
    return this.runExclusive(() => this.doExport(req));
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async doExport(req: ExportRequest): Promise<ExportResult> {
    const cfg = {
      rootDir: this.config.rootDir,
      baseUrl: this.config.baseUrl,
      ttlHours: this.config.ttlHours ?? EXPORT_DEFAULTS.ttlHours,
      maxRows: this.config.maxRows ?? EXPORT_DEFAULTS.maxRows,
      maxBytes: this.config.maxBytes ?? EXPORT_DEFAULTS.maxBytes,
      timeoutMs: this.config.timeoutMs ?? EXPORT_DEFAULTS.timeoutMs,
      maxFilesPerOwner: this.config.maxFilesPerOwner ?? EXPORT_DEFAULTS.maxFilesPerOwner,
      maxBytesPerOwner: this.config.maxBytesPerOwner ?? EXPORT_DEFAULTS.maxBytesPerOwner,
      fileMode: this.config.fileMode ?? EXPORT_DEFAULTS.fileMode,
      dirMode: this.config.dirMode ?? EXPORT_DEFAULTS.dirMode,
    };

    // 3. Owner directory (never a symlink) and per-owner file-count quota.
    let ownerDir: string;
    try {
      ownerDir = await ensureOwnerDir(cfg.rootDir, req.ownerId, cfg.dirMode);
      await enforceFileCountQuota(ownerDir, cfg.maxFilesPerOwner);
    } catch (err) {
      if (err instanceof PathSafetyError) {
        return { ok: false, code: 'IO_ERROR', error: 'Export directory is not safe to use.' };
      }
      return { ok: false, code: 'IO_ERROR', error: 'Could not prepare the export directory.' };
    }

    // 4. Open the row stream. Re-validation happens inside openRowStream.
    let stream: RowStream;
    try {
      stream = await this.client.openRowStream(req.sql, { timeoutMs: cfg.timeoutMs });
    } catch (err) {
      if (err instanceof SqlRejectedError) {
        return { ok: false, code: 'REJECTED', error: err.reason };
      }
      if (isTimeoutError(err)) {
        return { ok: false, code: 'TIMEOUT', error: 'The export query timed out.' };
      }
      return { ok: false, code: 'DB_ERROR', error: errMsg(err) };
    }

    // From here on every path must destroy the stream and remove partial files.
    const toRemoveOnFailure: string[] = [];
    try {
      // 5. Names. Temp files live in the owner dir so rename() is atomic.
      const now = new Date();
      const { fileName, token } = buildFileName(req.question, now);
      const csvFinal = resolveInside(cfg.rootDir, req.ownerId, `${fileName}.csv`);
      const jsonFinal = resolveInside(cfg.rootDir, req.ownerId, `${fileName}.json`);
      const csvTmp = resolveInside(cfg.rootDir, req.ownerId, `.tmp-${token}.csv`);
      const jsonTmp = resolveInside(cfg.rootDir, req.ownerId, `.tmp-${token}.json`);
      toRemoveOnFailure.push(csvTmp, jsonTmp);

      // 6. Pipeline: rows -> CSV -> counter/hasher -> temp file.
      const columns = stream.columns;
      const counter = new ByteCounter();
      let rowCount = 0;
      let truncatedReason: 'rows' | 'bytes' | undefined;
      // Set when the row source itself fails. pipeline() then destroys the file
      // stream with that same error, so the file stream's error event cannot be
      // used on its own to tell the two apart.
      let sourceError: unknown;

      async function* limitedRows(): AsyncGenerator<string[]> {
        try {
          for await (const row of stream.rows) {
            // Only reached when another row actually exists, so a result with
            // exactly maxRows rows is not reported as truncated.
            if (rowCount >= cfg.maxRows) {
              truncatedReason = 'rows';
              break;
            }
            if (counter.bytes > cfg.maxBytes) {
              truncatedReason = 'bytes';
              break;
            }
            rowCount++;
            yield columns.map((c) => csvCell((row as Record<string, unknown>)[c]));
          }
        } catch (err) {
          sourceError = err;
          throw err;
        } finally {
          await stream.destroy();
        }
      }

      const stringifier = stringify({
        header: true,
        // Records are arrays; csv-stringify needs string keys ('0', '1', ...).
        // Header names go through csvCell too (aliases come from LLM output).
        columns: columns.map((c, i) => ({ key: String(i), header: csvCell(c) })),
        bom: true, // UTF-8 BOM so Excel reads UTF-8
        record_delimiter: 'windows', // CRLF per RFC 4180
        quoted_string: false, // quote only when needed...
        quoted_match: /[\r\n]/, // ...but always when a cell has CR/LF (CRLF mode alone misses a bare LF)
      });

      const signal = AbortSignal.timeout(cfg.timeoutMs);
      // Destroying Readable.from(generator) waits for the generator's return(),
      // which cannot run while it is stuck on a source that never yields. Kill
      // the source directly so the pipeline can unwind.
      const onAbort = () => void stream.destroy();
      signal.addEventListener('abort', onAbort, { once: true });

      const out = createWriteStream(csvTmp, { mode: cfg.fileMode, flags: 'wx' });
      let ioFailed = false;
      out.on('error', () => {
        ioFailed = true;
      });

      try {
        await pipeline(Readable.from(limitedRows()), stringifier, counter, out, { signal });
      } catch (err) {
        await Promise.all(toRemoveOnFailure.map(unlinkQuiet));
        if (signal.aborted || isTimeoutError(err)) {
          return { ok: false, code: 'TIMEOUT', error: 'The export took too long.' };
        }
        if (sourceError === undefined && ioFailed) {
          return { ok: false, code: 'IO_ERROR', error: 'Could not write the export file.' };
        }
        return { ok: false, code: 'DB_ERROR', error: errMsg(err) };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }

      // 7. Nothing to export.
      if (rowCount === 0) {
        await Promise.all(toRemoveOnFailure.map(unlinkQuiet));
        return { ok: false, code: 'EMPTY', error: 'No rows to export.' };
      }

      // 8. Commit. The sidecar is written LAST: it is the "ready" marker.
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + cfg.ttlHours * 3_600_000).toISOString();
      const bytes = counter.bytes;
      const sidecar: ExportSidecar = {
        version: 1,
        id: token,
        ownerId: req.ownerId,
        fileName: `${fileName}.csv`,
        createdAt,
        expiresAt,
        rowCount,
        columns,
        truncated: truncatedReason !== undefined,
        truncatedReason: truncatedReason ?? null,
        bytes,
        sha256: counter.digest(),
        question: req.question ? req.question.slice(0, MAX_QUESTION_CHARS) : null,
      };

      await fs.rename(csvTmp, csvFinal);
      toRemoveOnFailure.push(csvFinal); // a CSV without a sidecar must not be left behind
      await fs.chmod(csvFinal, cfg.fileMode);

      await fs.writeFile(jsonTmp, JSON.stringify(sidecar, null, 2) + '\n', {
        mode: cfg.fileMode,
        flag: 'wx',
      });
      await fs.rename(jsonTmp, jsonFinal);
      await fs.chmod(jsonFinal, cfg.fileMode);
      toRemoveOnFailure.length = 0; // fully committed

      // 9. Per-owner byte quota (never deletes the file just written).
      // Best effort: the export itself already succeeded.
      try {
        await enforceByteQuota(ownerDir, cfg.maxBytesPerOwner, fileName);
      } catch {
        // ignore
      }

      // 10. Result.
      const url =
        cfg.baseUrl +
        '/' +
        encodeURIComponent(req.ownerId) +
        '/' +
        encodeURIComponent(fileName) +
        '.csv';

      return {
        ok: true,
        url,
        fileName,
        relativePath: path.posix.join(req.ownerId, `${fileName}.csv`),
        rowCount,
        columns,
        truncated: truncatedReason !== undefined,
        ...(truncatedReason ? { truncatedReason } : {}),
        bytes,
        expiresAt,
      };
    } catch (err) {
      await Promise.all(toRemoveOnFailure.map(unlinkQuiet));
      if (isTimeoutError(err)) {
        return { ok: false, code: 'TIMEOUT', error: 'The export took too long.' };
      }
      return { ok: false, code: 'IO_ERROR', error: 'Could not write the export file.' };
    } finally {
      await stream.destroy();
    }
  }
}
