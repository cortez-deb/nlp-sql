/**
 * examples/export-memory-check.ts
 *
 * Verifies that exporting is memory-flat: exports N rows from a lazily
 * generated fake stream (no database needed) and reports memory use.
 *
 * Two things are reported:
 *  - "retained after GC": heap still in use after the export finished and a
 *    full GC ran. This is the real leak signal and should stay ~0 at any size.
 *  - "peak heap/RSS growth": includes garbage V8 has not collected yet, so it
 *    can look proportional to row count even when nothing is retained. For a
 *    hard proof, run under a small heap cap; 400k rows (~48 MB of CSV) must still
 *    complete:
 *      node --expose-gc --max-old-space-size=40 dist/examples/export-memory-check.js
 *
 * Run:
 *   npx tsc && node --expose-gc dist/examples/export-memory-check.js
 */

import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { Readable } from 'stream';

import { CsvExportService } from '../export';
import type { RowStream } from '../db/MySQLAdapter';

const MB = 1024 * 1024;
const gc = (globalThis as { gc?: () => void }).gc;

function fakeSource(rowCount: number): RowStream {
  async function* gen() {
    for (let i = 0; i < rowCount; i++) {
      yield {
        id: i,
        name: `Customer ${i} Zoë`,
        email: `customer${i}@example.com`,
        note: 'x'.repeat(60),
        total: (i * 1.37).toFixed(2),
      };
    }
  }
  const rows = Readable.from(gen(), { objectMode: true, highWaterMark: 100 });
  return {
    columns: ['id', 'name', 'email', 'note', 'total'],
    rows: rows as RowStream['rows'],
    destroy: async () => {
      if (!rows.destroyed) rows.destroy();
    },
  };
}

async function runOnce(rootDir: string, rowCount: number) {
  const svc = new CsvExportService(
    { openRowStream: async () => fakeSource(rowCount) },
    {
      rootDir,
      baseUrl: 'http://localhost/dl',
      maxRows: rowCount + 1,
      maxBytes: 10 * 1024 * MB,
      timeoutMs: 10 * 60_000,
    }
  );

  gc?.();
  const before = process.memoryUsage();
  let peakRss = before.rss;
  let peakHeap = before.heapUsed;
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakHeap = Math.max(peakHeap, m.heapUsed);
  }, 20);

  const started = Date.now();
  const res = await svc.export({ ownerId: 'memcheck', sql: 'SELECT 1' });
  clearInterval(sampler);
  if (!res.ok) throw new Error(`${res.code}: ${res.error}`);

  const fileMb = statSync(path.join(rootDir, res.relativePath)).size / MB;
  gc?.();
  const retained = process.memoryUsage().heapUsed - before.heapUsed;
  console.log(
    `${String(rowCount).padStart(8)} rows | file ${fileMb.toFixed(1).padStart(6)} MB | ` +
      `retained after GC ${(retained / MB).toFixed(2).padStart(6)} MB | ` +
      `peak heap +${((peakHeap - before.heapUsed) / MB).toFixed(1).padStart(5)} MB | ` +
      `peak RSS +${((peakRss - before.rss) / MB).toFixed(1).padStart(5)} MB | ` +
      `${Date.now() - started} ms`
  );
}

async function main() {
  if (!gc) console.warn('Tip: run with --expose-gc for steadier numbers.\n');
  const dir = mkdtempSync(path.join(tmpdir(), 'nlsql-mem-'));
  try {
    // Warm-up so one-time allocations (JIT, module load) do not skew the first row.
    await runOnce(dir, 5_000);
    console.log('(peak figures include uncollected garbage; "retained" is the leak signal)');
    for (const n of [25_000, 100_000, 400_000]) {
      await runOnce(dir, n);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
