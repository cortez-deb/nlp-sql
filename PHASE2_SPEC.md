# nlsql — Phase 2 implementation spec: CSV export with download links

Audience: a coding agent working in `cortez-deb/nlp-sql` AFTER Phase 1 (`PHASE1_SPEC.md`) is complete and green.
This phase adds one capability: turn a query into a CSV file, drop it in a downloads directory that a separate web app serves,
and return a download URL that the (Phase 3) WhatsApp bot sends to the user.

Out of scope: the web app itself (auth, serving), the open-wa webhook/bot (Phase 3). This spec defines the contract with both.

Working rules: same as Phase 1 (run `npm run lint` and `npm test` after each section; fail closed; inspect real library shapes
before depending on them; do not push or publish; no secrets in the repo).

---------------------------------------------------------------------------------------------------

## 0. Decisions and assumptions

| Topic | Decision |
|---|---|
| What gets exported | The SQL of a query, re-executed with a high row cap and streamed to disk. Not the 1000-row preview. |
| Where the code lives | `src/export/` in this repo, exported from `src/index.ts`. It is framework-independent; Phase 3 just calls it. |
| Where files go | `<EXPORT_ROOT_DIR>/<ownerId>/<fileName>.csv` plus a sidecar `<fileName>.json`. Default root `/var/www/downloads`. |
| Auth / serving | Done by the separate web app. This code only writes files and builds the URL. Files are still unguessable (128-bit token in the name) and expire. |
| Assumption | The bot process can write to `EXPORT_ROOT_DIR` (same host as the web app, or a mounted volume). Local filesystem only; no SFTP/HTTP upload sink in this phase. |
| Library | `csv-stringify` for CSV encoding. Node built-in streams for the rest. |

---------------------------------------------------------------------------------------------------

## 1. Library addition: stream rows without the preview cap

`executeQuery` (Phase 1, 2.4) caps rows and loads everything into memory. Exports need streaming.

### 1.1 `MySQLAdapter.openStream`
```ts
export interface RowStream {
  columns: string[];                       // known before the first row (from the 'fields' event)
  rows: NodeJS.ReadableStream & AsyncIterable<Record<string, unknown>>;   // object-mode Readable
  destroy(): Promise<void>;                // idempotent; stops the query and discards the connection
}
openStream(sql: string, opts: { timeoutMs: number }): Promise<RowStream>
```
Implementation:
- `const conn = await this.pool.getConnection();`
- Apply the per-connection timeout for this statement: MySQL `SET SESSION MAX_EXECUTION_TIME = <timeoutMs>`;
  MariaDB `SET SESSION max_statement_time = <seconds>` (reuse the version detection from Phase 1, 2.3).
  The Phase 1 pool hook already set `READ ONLY`; keep it.
- Start the query on the underlying callback connection: `const q = (conn as any).connection.query(sql); const rows = q.stream({ highWaterMark: 100 });`
  (inspect the installed mysql2 types; with `mysql2/promise` the callback connection is `conn.connection`).
- Resolve the returned promise when the first of these happens: `q.on('fields', f => ...)` (set `columns = f.map(x => x.name)`),
  `error` (reject), or `end` with no fields (resolve with `columns = []`).
- `destroy()`: `rows.destroy()`, then `conn.destroy()` (NOT `release()`): the session variables were changed and a connection
  interrupted mid-stream must not return to the pool. Guard so it only runs once.
- Always call `destroy()` on every completion path, including success (the connection is discarded and the pool replaces it; acceptable for an occasional export).
- Pool options from Phase 1 (`dateStrings`, `decimalNumbers`, `bigNumberStrings`) already apply to streamed rows.

### 1.2 `NLSQLClient.openRowStream`
```ts
async openRowStream(sql: string, opts?: { timeoutMs?: number }): Promise<RowStream>
```
- Calls `assertInitialised`.
- ALWAYS re-validates `sql` with `SQLValidator.validate(sql, { allowedTables, allowedDatabase })` (never trust SQL kept in chat state).
  On failure throw `SqlRejectedError` (new exported class extending `Error`, with `.reason` and `.kind`).
- Does NOT append a LIMIT (the exporter enforces the row cap while reading).
- `timeoutMs` default = `config.export?.timeoutMs ?? 60_000`.
Export `RowStream` and `SqlRejectedError` from `src/index.ts`.
Tests: valid SQL streams all rows of a mocked connection; invalid SQL throws before any connection is taken; `destroy()` is idempotent.

---------------------------------------------------------------------------------------------------

## 2. Export module (`src/export/`)

Files: `types.ts`, `CsvExportService.ts`, `csvCell.ts`, `paths.ts`, `cleanup.ts`, `intent.ts`, `config.ts`, `index.ts`.

### 2.1 Types (`types.ts`)
```ts
export interface ExportConfig {
  rootDir: string;               // absolute, e.g. /var/www/downloads
  baseUrl: string;               // e.g. https://files.example.com/downloads   (no trailing slash)
  ttlHours?: number;             // default 24
  maxRows?: number;              // default 100_000
  maxBytes?: number;             // default 50 * 1024 * 1024
  timeoutMs?: number;            // default 60_000
  maxFilesPerOwner?: number;     // default 20
  maxBytesPerOwner?: number;     // default 200 * 1024 * 1024
  fileMode?: number;             // default 0o640
  dirMode?: number;              // default 0o750
}
export interface ExportRequest {
  ownerId: string;               // see 2.3
  sql: string;                   // last successful SQL for this chat, or the SQL from a fresh query()
  question?: string;             // used for the file-name slug and stored in the sidecar
}
export type ExportResult =
  | { ok: true;  url: string; fileName: string; relativePath: string; rowCount: number; columns: string[];
      truncated: boolean; truncatedReason?: 'rows' | 'bytes'; bytes: number; expiresAt: string }
  | { ok: false; code: 'EMPTY' | 'REJECTED' | 'TIMEOUT' | 'DB_ERROR' | 'IO_ERROR' | 'BAD_OWNER'; error: string };
```
`CsvExportService` constructor: `(client: { openRowStream(sql, opts): Promise<RowStream> }, config: ExportConfig)`.
(Depend on the minimal interface, not the whole `NLSQLClient`, so tests can pass a fake.)

### 2.2 `CsvExportService.export(req): Promise<ExportResult>`
Steps:
1. Validate `ownerId` (2.3). Bad -> `{ ok:false, code:'BAD_OWNER' }`.
2. Acquire the global export mutex (one export at a time; queue others in memory).
3. Ensure `<rootDir>/<ownerId>/` exists (`mkdir` recursive with `dirMode`). Enforce per-owner file-count quota (2.7) before writing.
4. `stream = await client.openRowStream(req.sql, { timeoutMs })`. Map `SqlRejectedError` -> `REJECTED`; other errors -> `DB_ERROR`.
5. Build names (2.3). Temp path = `<ownerDir>/.tmp-<token>.csv` (same directory, so `rename` is atomic on the same filesystem).
6. Pipeline (`stream/promises.pipeline`, with an `AbortSignal` from `AbortSignal.timeout(timeoutMs)`):
   `Readable.from(limitedRows())` -> `csv-stringify` -> byte counter + sha256 hasher (PassThrough) -> `fs.createWriteStream(tmp, { mode: fileMode })`.
   - `limitedRows()` is an async generator over `stream.rows` that: counts rows; stops (and sets `truncatedReason='rows'`) when count reaches `maxRows`;
     stops (and sets `'bytes'`) when the byte counter has passed `maxBytes`; converts each row to an array in `columns` order using `csvCell` (2.4).
     Leaving the loop early must destroy the source (`stream.destroy()` in a `finally`).
   - `csv-stringify` options: `{ header: true, columns: stream.columns (sanitised with csvCell), bom: true, record_delimiter: 'windows', quoted_string: false }`
     (UTF-8 BOM so Excel reads UTF-8; CRLF per RFC 4180; quote only when needed).
7. If `rowCount === 0`: delete the temp file, `destroy()` the stream, return `{ ok:false, code:'EMPTY', error:'No rows to export.' }`.
8. Commit in this order (the sidecar is the "ready" marker the web app relies on):
   a. `rename(tmp, <ownerDir>/<fileName>.csv)`; `chmod` to `fileMode`.
   b. write `<ownerDir>/.tmp-<token>.json` then `rename` to `<ownerDir>/<fileName>.json` (sidecar, 2.5); `chmod` to `fileMode`.
9. Enforce per-owner byte quota (2.7), never deleting the file just written.
10. Return `ok:true` with `url = baseUrl + '/' + encodeURIComponent(ownerId) + '/' + encodeURIComponent(fileName) + '.csv'`.
Failure handling: on any error after step 5, delete the temp files; on timeout return `TIMEOUT`; on filesystem errors `IO_ERROR`.
`finally`: `await stream.destroy()`, release the mutex.

### 2.3 Names and paths (`paths.ts`) — path traversal is the main risk
- `ownerId` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. Never build a path from a raw WhatsApp chat id (`2547...@c.us`): Phase 3 maps
  an allowlisted sender to an `ownerId` (default: the phone number's digits). Reject everything else, including `.`, `/`, `\`, NUL, `..`.
- `fileName` (without extension) = `<UTCyyyyMMdd-HHmmss>_<slug>_<token>` where
  `slug` = question lowercased, non-alphanumerics collapsed to `-`, trimmed, max 40 chars, fallback `export`;
  `token` = `crypto.randomBytes(16).toString('hex')` (32 hex chars, unguessable).
- Final filename regex (also used by cleanup): `^\d{8}-\d{6}_[a-z0-9-]{1,40}_[0-9a-f]{32}$`.
- After building each path, `path.resolve` it and assert it starts with `path.resolve(rootDir) + path.sep`. Do not follow symlinks:
  use `fs.lstat` on the owner dir and refuse if it is a symlink.

### 2.4 CSV cell rules (`csvCell.ts`) — pure functions, heavily tested
`csvCell(value: unknown): string`
- `null`/`undefined` -> `''`; `string` -> see formula guard; `number`/`bigint`/`boolean` -> `String(v)`;
  `Date` -> `toISOString()`; `Buffer` -> `'0x' + hex`; plain object/array (JSON columns) -> `JSON.stringify`.
- Formula-injection guard (spreadsheet apps execute cells starting with `= + - @`, tab or CR): for STRING values that start with one of
  `= + - @ \t \r`, prefix a single quote `'` — EXCEPT when the whole string is a plain number (`/^-?\d+(\.\d+)?$/`, e.g. `-12.50`,
  and big integers delivered as strings by `bigNumberStrings`). Apply the same function to header names (aliases come from LLM output).
Tests: `=SUM(A1:A2)` -> `'=SUM(A1:A2)`; `-12.50` unchanged; `-abc` -> `'-abc`; `@cmd` -> `'@cmd`; null -> empty; Date ISO; Buffer hex; object JSON;
header guard; strings with commas/quotes/newlines still round-trip through `csv-stringify` and `csv-parse` (dev dependency).

### 2.5 Sidecar JSON (`<fileName>.json`) — contract with the web app
```json
{
  "version": 1,
  "id": "<token>",
  "ownerId": "254712345678",
  "fileName": "20261007-190501_top-5-customers_<token>.csv",
  "createdAt": "2026-10-07T19:05:01.000Z",
  "expiresAt": "2026-10-08T19:05:01.000Z",
  "rowCount": 1234,
  "columns": ["id", "name"],
  "truncated": false,
  "truncatedReason": null,
  "bytes": 45678,
  "sha256": "<hex of the CSV bytes>",
  "question": "top 5 customers by spend"
}
```
Do not store the SQL (only the question). `question` is user text; the web app must HTML-escape it if it ever renders it.

### 2.6 Cleanup (`cleanup.ts`)
`cleanupExpired(config, now = new Date()): Promise<{ deleted: number }>` and `startCleanupTimer(config, intervalMs = 3_600_000): { stop(): void }`.
- Scan only direct children of `rootDir` whose names match the ownerId regex and are real directories (not symlinks).
- For each sidecar matching the filename regex: if `expiresAt < now`, delete the `.csv` first, then the `.json`.
- Delete leftover `.tmp-*` files older than 1 hour and `.csv` files with no sidecar older than 1 hour.
- Never delete anything that does not match the exact patterns above. Never recurse deeper than owner dirs. Log counts, not filenames.
- Run once at startup and then on the timer (`timer.unref()` so it never keeps the process alive).
Tests with a temp dir: expired removed, fresh kept, foreign files untouched, symlinked owner dir skipped, orphan temp removed.

### 2.7 Quotas
Before writing: if the owner has >= `maxFilesPerOwner` exports, delete the oldest (by `createdAt`) until under the limit.
After writing: while the owner's total bytes > `maxBytesPerOwner`, delete the oldest export other than the new one.
Both use the same delete routine as cleanup (csv first, then sidecar).

### 2.8 Config (`config.ts`)
`loadExportConfigFromEnv(env = process.env): ExportConfig` reading
`EXPORT_ROOT_DIR` (default `/var/www/downloads`), `EXPORT_BASE_URL` (required), `EXPORT_TTL_HOURS`, `EXPORT_MAX_ROWS`, `EXPORT_MAX_MB`, `EXPORT_TIMEOUT_MS`.
Validate at startup: `rootDir` is absolute, exists, is a directory and writable (`fs.access` W_OK), else throw a clear error;
`baseUrl` must be `https://` (allow `http://localhost` and `http://127.0.0.1` for dev); strip a trailing slash. Numbers must be positive integers.

### 2.9 Export intent helper (`intent.ts`) — pure, used by Phase 3
```ts
detectExportIntent(text: string): { kind: 'last' } | { kind: 'new'; question: string } | null
```
- `kind:'last'`: the whole trimmed, lowercased text is one of `csv`, `/csv`, `export`, `/export`, `send csv`, `send as csv`, `download`, `download csv`, `export csv`, `as csv`.
- `kind:'new'`: text contains the word `csv`, `export`, `download`, `excel` or `spreadsheet` plus other content. Return `question` = the text with
  those phrases removed (e.g. `"export all gold customers as csv"` -> `"all gold customers"`; remove patterns like `(as|in|to|into) (a )?(csv|excel|spreadsheet)( file)?` and the bare words `export`/`download`/`send me`), whitespace-normalised.
  If `question` ends up empty, treat it as `kind:'last'`.
- Otherwise `null`.
Tests: the examples above, plus `"how many exports did we have in August"` (contains "exports" not the word `export` -> `null`) and `"what is the export revenue by country"` (ambiguous: acceptable to return `kind:'new'`; document the limitation in a comment).

---------------------------------------------------------------------------------------------------

## 3. Contract the separate web app must honour (document in `docs/EXPORT_CONTRACT.md`, do not implement)

- Layout: `<root>/<ownerId>/<fileName>.csv` + `<fileName>.json`. A CSV is downloadable only when its sidecar exists (the sidecar is written last).
- Ignore dotfiles (`.tmp-*`). No directory listings.
- Authorise: the authenticated user must own `ownerId` (the mapping from login to `ownerId` is the web app's business). Return 404, not 403, for other owners' files.
- Reject expired files (`expiresAt`), even if the cleanup job has not removed them yet.
- Resolve the real path and verify it is inside the root (no `..`, no symlink escapes). Serve with
  `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<fileName>.csv"`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.
- Optional integrity check: compare the response body's SHA-256 with the sidecar `sha256`.
- Ops notes for the human (not the agent): the bot's OS user needs write access to the root; the web server's user needs read access
  (e.g. shared group, directory mode `2750`, `fileMode 0o640`). If the bot and the web app run on different machines, mount the directory
  (NFS/sshfs) or add an upload sink in a later phase.

---------------------------------------------------------------------------------------------------

## 4. Hand-off to Phase 3 (the bot) — interface only, do not build the bot here

Per chat the bot keeps `lastQuery = { question, sql }` set only when `query()` returned `error === null`.
Flow when `detectExportIntent(text)` is not null:
- `'last'` and a `lastQuery` exists -> `exportService.export({ ownerId, sql: lastQuery.sql, question: lastQuery.question })`. No `lastQuery` -> reply "Ask a question first, then reply `csv`."
- `'new'` -> run the normal `query(question)` pipeline; if it succeeded, export `result.sql`.
- Reply text (WhatsApp, plain text):
  - ok: `Export ready: {rowCount} rows, {columns.length} columns, {size}.\n{url}\nLink valid for {ttlHours}h.` plus `Limited to the first {maxRows} rows.` when `truncated` (or bytes variant).
  - `EMPTY`: `No rows to export.`  `REJECTED`: `I can't export that query.`  `TIMEOUT`: `The export took too long. Try a narrower question.`  other: `Export failed. Please try again.`
- After a normal answer where `QueryResult.truncated` is true or `rowCount > 15`, append `Reply "csv" to get the full result as a file.`
Export from `src/index.ts`: `CsvExportService`, `ExportConfig`, `ExportRequest`, `ExportResult`, `loadExportConfigFromEnv`, `detectExportIntent`,
`cleanupExpired`, `startCleanupTimer`.

---------------------------------------------------------------------------------------------------

## 5. Tests and definition of done

Unit tests (Jest, temp dirs via `fs.mkdtemp`, fake `openRowStream` returning `Readable.from(rows)`):
- Happy path: CSV bytes start with the UTF-8 BOM, CRLF line endings, header row, correct values; sidecar fields correct; `sha256` matches the file;
  URL is `baseUrl/ownerId/fileName.csv`; file modes applied; no `.tmp-*` left behind.
- Truncation: `maxRows` reached -> `truncated:true, truncatedReason:'rows'`, source stream destroyed; `maxBytes` reached -> `'bytes'`.
- `EMPTY`: no csv, no sidecar left.
- `ownerId` values `../x`, `a/b`, `.`, `''`, 65 chars -> `BAD_OWNER`, nothing written outside the root.
- Symlinked owner directory is refused.
- Timeout: a source that never ends aborts, temp files removed, `TIMEOUT` returned.
- DB error mid-stream: temp files removed, `DB_ERROR`.
- Quotas: oldest exports evicted; new file never evicted.
- Mutex: two concurrent exports run sequentially.
- `csvCell`, `detectExportIntent`, `cleanupExpired`, `loadExportConfigFromEnv` as described above.

Done when:
- `npm run lint` and `npm test` pass; `src/index.ts` exports the items listed in section 4.
- With a real MySQL (`shop_sample.sql`) and `EXPORT_ROOT_DIR` pointing at a temp directory, a script `src/examples/export-usage.ts` runs
  `query()`, then `exportService.export()` for the returned SQL, prints the URL, and the resulting CSV opens correctly in a spreadsheet
  with a UTF-8 name such as `Zoë` and a value like `=1+1` displayed as text.
- Memory stays flat when exporting 100k rows (verify with a generated table or a fake stream: process RSS does not grow with row count).
- `docs/EXPORT_CONTRACT.md` exists and matches section 3.
- No credentials, base URLs or real paths are committed; `.env.example` lists the `EXPORT_*` variables.
