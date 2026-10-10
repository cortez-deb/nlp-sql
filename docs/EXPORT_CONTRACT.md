# Export contract for the web app

This document is what the separate web app (the thing that authenticates users
and serves downloads) must honour. `nlsql` only **writes** files and builds the
URL; it does not serve, authenticate or authorise anything.

## Layout

```
<root>/<ownerId>/<fileName>.csv     the data
<root>/<ownerId>/<fileName>.json    the sidecar ("ready" marker + metadata)
<root>/<ownerId>/.tmp-<token>.*     in-progress files (ignore)
```

- `<root>` is `EXPORT_ROOT_DIR`.
- `<ownerId>` matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
- `<fileName>` matches `^\d{8}-\d{6}_[a-z0-9-]{1,40}_[0-9a-f]{32}$`
  (UTC timestamp, a slug of the question, then a 128-bit random token).
- The download URL is `<EXPORT_BASE_URL>/<ownerId>/<fileName>.csv`.

A CSV is **downloadable only when its sidecar exists.** The sidecar is written
last (after the CSV is renamed into place), so its presence means the CSV is
complete.

## Sidecar (`<fileName>.json`)

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

- `truncatedReason` is `"rows"`, `"bytes"` or `null`.
- The SQL is never stored; only the question.
- `question` is user-supplied text. **HTML-escape it** if you ever render it.

## What the web app must do

1. **Ignore dotfiles.** Never serve or list anything starting with `.`
   (`.tmp-*`). No directory listings.
2. **Authorise.** The authenticated user must own `ownerId`. How a login maps to
   an `ownerId` is the web app's business. Return **404, not 403**, for another
   owner's files so their existence is not revealed.
3. **Require the sidecar.** If `<fileName>.json` does not exist, return 404.
4. **Reject expired files.** If `expiresAt` is in the past, return 404 (or 410),
   even if the cleanup job has not removed the file yet.
5. **Validate the path.** Validate `ownerId` and `fileName` against the patterns
   above first. Then resolve the real path and verify it is inside the root: no
   `..`, no symlink escapes (compare `realpath` of the file against `realpath` of
   the root).
6. **Serve with these headers:**
   ```
   Content-Type: text/csv; charset=utf-8
   Content-Disposition: attachment; filename="<fileName>.csv"
   X-Content-Type-Options: nosniff
   Cache-Control: private, no-store
   ```
7. **Optional integrity check.** Compare the SHA-256 of the response body with the
   sidecar's `sha256`.

## CSV format

- UTF-8 with a BOM (so Excel reads UTF-8), CRLF line endings, header row.
- Cells are quoted only when needed (commas, quotes, CR/LF).
- Spreadsheet formula guard: a text cell starting with `=`, `+`, `-`, `@`, tab or
  CR (other than a plain number) is prefixed with a single quote `'`. Header names
  get the same treatment. Do not "fix" this in the web app.
- Nulls are empty cells; dates are ISO 8601; binary values are `0x<hex>`;
  JSON values are JSON text.

## Retention

- Files expire after `EXPORT_TTL_HOURS` (default 24). `nlsql` deletes expired
  exports itself (hourly job, and at startup), so a download link can stop
  working at any time.
- Per owner: at most 20 exports and 200 MB; the oldest are removed first.

## Ops notes (for the human)

- The bot's OS user needs **write** access to the root; the web server's user
  needs **read** access. For example a shared group, with directory mode `2750`
  and file mode `0o640` (the defaults are `dirMode 0o750`, `fileMode 0o640`).
- The code writes to the local filesystem only. If the bot and the web app run
  on different machines, mount the directory (NFS/sshfs) or add an upload sink
  in a later phase.
