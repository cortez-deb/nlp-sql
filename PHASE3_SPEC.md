# nlsql — Phase 3 implementation spec: WhatsApp bot (webhook service for a self-hosted WhatsApp gateway)

Audience: a coding agent working in `cortez-deb/nlp-sql` AFTER Phase 1 (`PHASE1_SPEC.md`) and Phase 2 (`PHASE2_SPEC.md`) are complete and green.
Goal: a small HTTP service that receives WhatsApp gateway webhooks, answers questions about a MySQL database through `NLSQLClient`,
formats answers for WhatsApp, and sends CSV download links (Phase 2). Single user (the owner), single instance, no scaling work.

Working rules: same as Phases 1-2 (lint + tests after each section; fail closed; inspect real shapes before depending on them;
no pushing/publishing; no secrets in the repo). Where this spec says "VERIFY", the behaviour could not be confirmed from public docs, so build it configurable and covered by fixtures.
The `openwa-gateway` flavor IS verified against that project's own docs (section 2.1); the `wa-automate` flavor is not.

---------------------------------------------------------------------------------------------------

## 0. Decisions and assumptions

| Topic | Decision |
|---|---|
| WhatsApp server | A self-hosted gateway on a remote host, selected by `OPENWA_FLAVOR`: `openwa-gateway` (github.com/rmyndharis/OpenWA, NestJS; contract verified from its docs) or `wa-automate` (open-wa Easy API; contract NOT verified). The bot is a separate service on another host. |
| Inbound | The gateway POSTs each incoming message to our webhook URL. |
| Outbound | Bot calls the gateway's REST send-text endpoint with the API key. |
| Users | Allowlist of sender IDs (the owner). Everyone else is ignored silently. |
| Stack | Node >= 20, TypeScript (CommonJS, matches the library), Fastify 5, `zod` for env validation, `pino` logs. |
| State | In memory (per-chat history, rate limits, dedup). Lost on restart; acceptable. |
| Code location | `bot/` folder in this repo with its own `package.json`, depending on the library via `"nlsql": "file:.."`. |
| Version risk | The two gateways have different APIs, and wa-automate v4/v5 differ from each other. One adapter per flavor behind a common interface; fixtures per flavor. |

---------------------------------------------------------------------------------------------------

## 1. Repo layout and tooling

```
bot/
  package.json            # name "nlsql-bot", private, scripts: build, start, dev, test, lint
  tsconfig.json           # extends nothing; target ES2022, module commonjs, strict, outDir dist, rootDir src
  .env.example
  config/examples.json    # optional few-shot [{ "question": "...", "sql": "..." }]
  src/
    index.ts              # bootstrap, graceful shutdown
    config.ts             # env -> typed config (zod)
    server.ts             # Fastify routes
    gateway/types.ts      # GatewayAdapter, InboundMessage, ParseResult
    gateway/openwa.ts     # flavor 'openwa-gateway'
    gateway/waAutomate.ts # flavor 'wa-automate'
    gateway/signature.ts  # HMAC verification (openwa-gateway)
    gateway/index.ts      # createGateway(config)
  scripts/registerWebhook.ts   # openwa-gateway only, see 2.1
    access.ts             # allowlist + ownerId mapping
    router.ts             # handleInbound(): the whole message flow
    commands.ts           # slash commands
    state.ts              # ChatState store (history, lastQuery, rate limits, dedup)
    format.ts             # WhatsApp formatting
    logger.ts
  tests/ (+ tests/fixtures/*.json)
```
- `bot/package.json` dependencies: `nlsql` (`file:..`), `fastify`, `zod`, `pino`. Dev: `typescript`, `jest`, `ts-jest`, `@types/*`, `pino-pretty`.
- Script `build` = `npm --prefix .. run build && tsc`. `start` = `node dist/index.js`. `dev` = `ts-node-dev` or `tsx watch` (pick one, pin it).
- ROOT `package.json` jest config: add `"testPathIgnorePatterns": ["/node_modules/", "/bot/"]` so the library's Jest does not pick up bot tests.
  The bot has its own Jest config.
- Add `bot/.env`, `bot/dist/`, `bot/.capture/` to `.gitignore`.

---------------------------------------------------------------------------------------------------

## 2. Step 0 — gateway contracts and capture mode

The two supported gateways are different products with different APIs. How to tell which one you run:
OpenWA gateway = NestJS app, default port 2785, dashboard and Swagger (`/api/docs`) on the same port.
wa-automate / open-wa Easy API = started with `npx @open-wa/wa-automate`, Swagger at `/api-docs/`, webhook bodies like `{"event":"onMessage",...}`.
Set `OPENWA_FLAVOR` accordingly (required, no default).

### 2.1 `openwa-gateway` — VERIFIED from github.com/rmyndharis/OpenWA docs (commit a80dbfa: `docs/06-api-specification.md` sections 6.4.8 and 6.6, `docs/examples/webhook-signature-verification.md`)
- Base URL: `http://<host>:2785` by default. Swagger UI `/api/docs` is off in production unless `ENABLE_SWAGGER=true`; `openapi.json` is in the repo.
- Auth on every REST call: header `X-API-Key: <key>` (header only; no query-string keys). In the Docker setup the key is written to `/app/data/.api-key`.
- Sessions: `sessionId` is a path parameter. Created with `POST /api/sessions {"name"}`, started with `POST /api/sessions/{sessionId}/start`, paired via `GET .../qr` or a pairing code. The human does this once (dashboard or curl); the bot only needs the resulting `OPENWA_SESSION_ID` (the docs show both UUIDs and names like `my-session`; use exactly what the API returns).
- Send text: `POST /api/sessions/{sessionId}/messages/send-text`, body `{"chatId":"628123456789@c.us","text":"..."}` -> `201 {"messageId","timestamp"}` (accepted, not delivered).
  Errors use `{"statusCode","message","error"}`: `400` validation or session not active, `401` bad key, `403` role below OPERATOR, `404` session not found,
  `409` engine not ready (retryable), `429` with `code:"SEND_PACING_LIMITED"` and `retryAfterSeconds`, `500` engine error.
- Typing indicator (optional): `POST /api/sessions/{sessionId}/chats/typing {"chatId","state":"typing"|"paused"}`. Mark read: `POST .../chats/read {"chatId"}`.
- Webhook registration: `POST /api/sessions/{sessionId}/webhooks` with `{"url","events":["message.received"],"secret":"<>=16 chars","filters":{"conditions":[...]},"retryCount":3}` (OPERATOR key).
  Recommended filters (gateway-side pre-filter; the bot still re-checks everything): `[{"field":"fromMe","operator":"is","value":false},{"field":"isGroup","operator":"is","value":false}]`.
  SSRF guard: registration is rejected with `400` when the URL resolves to a private/loopback address unless the gateway's `SSRF_ALLOWED_HOSTS` allows that host. The bot runs on a different server, so use a public HTTPS hostname or set `SSRF_ALLOWED_HOSTS` on the gateway. URLs with embedded credentials are rejected.
- Delivery body (JSON, HTTP POST):
  `{ "event":"message.received", "timestamp":"<ISO>", "sessionId":"<id>", "idempotencyKey":"msg_<session>_<msgId>_<webhookId>", "deliveryId":"dlv_<uuid>", "data":{...} }`
  `data` for `message.received` is the full message object: `id, from, to, body, type ("text"|"image"|...), timestamp (epoch SECONDS), isGroup, kind ("individual"|"group"|"channel"|"status"|"broadcast"|"unknown"), fromMe, chatId, author?, contact?{name?,pushName?}, media?`,
  plus `senderPhone` (digits or null) for `@lid` senders ONLY when the gateway runs with `RESOLVE_LID_TO_PHONE=true`. Direct chats end in `@c.us`, groups in `@g.us`.
- Delivery headers: `X-OpenWA-Signature: sha256=<hex>` (only when a secret is set), `X-OpenWA-Event`, `X-OpenWA-Idempotency-Key`, `X-OpenWA-Delivery-Id`, `X-OpenWA-Retry-Count`.
  Signature = HMAC-SHA256 over the EXACT raw request body bytes, keyed with the webhook secret, hex, prefixed `sha256=`; compare in constant time; parse JSON only after it verifies.
- Semantics: at-least-once. A non-2xx response, timeout (default 10 s) or network error is retried (default 3 attempts, exponential backoff from 5 s). Dedupe on `X-OpenWA-Idempotency-Key`. Disappearing messages are not delivered when the gateway has `STORE_EPHEMERAL_MESSAGES=false`.
- Still VERIFY with a capture (2.3): the exact `data` field set on your engine (whatsapp-web.js vs Baileys differ in optional fields).
- Tooling the agent builds: `bot/scripts/registerWebhook.ts` (`npm run register-webhook`) reads `OPENWA_BASE_URL`, `OPENWA_API_KEY`, `OPENWA_SESSION_ID`, `WEBHOOK_PUBLIC_URL` (full URL incl. path token), `WEBHOOK_HMAC_SECRET`;
  lists `GET /api/sessions/{id}/webhooks`; if one with the same URL exists it `PUT`s the update, else it `POST`s a new one with the recommended events/filters. Prints the result without echoing secrets.

### 2.2 `wa-automate` — open-wa Easy API (NOT VERIFIED: its public docs only point to the running server's `/api-docs/`; v5 alpha also changed webhook setup to `@open-wa/integration-webhook` in `wa.config.*`)
Expected, v4 style — confirm on your server's `/api-docs/`:
- Send: `POST /sendText` JSON `{"args":{"to":"<chatId>","content":"<text>"}}`; auth header probably `api_key: <key>` (`X-API-Key` possible).
- Webhook: `POST <url>` JSON `{"ts","event":"onMessage","session","data":{<Message>}}`; `Message` fields: `id`, `body`, `from`, `chatId`, `sender.id`, `fromMe`, `isGroupMsg`, `type` (`"chat"` = text), `t` (epoch seconds).
- No documented signature: protect the webhook with the secret path token (section 5).

### 2.3 Capture mode (`CAPTURE_MODE=1`, both flavors)
The server writes each raw webhook (body, plus request headers with `x-openwa-signature` and any api-key header values masked) to `bot/.capture/<timestamp>.json` (max 200 files, oldest rotated),
logs `captured` at info level, performs NO processing and sends NO replies. README "First run" tells the human to:
1. confirm the flavor and the send endpoint/auth (openwa-gateway: `/api/docs`; wa-automate: `/api-docs/`) and fill the `OPENWA_*` variables;
2. register the webhook (openwa-gateway: `npm run register-webhook`; wa-automate: start open-wa with `-w https://<bot-host>/webhook/<WEBHOOK_PATH_TOKEN>` or the v5 equivalent);
3. start the bot with `CAPTURE_MODE=1`, send "hello" from the owner's phone, and copy `.capture/*.json` into `tests/fixtures/` (replacing the samples);
4. note which sender id form appears (`@c.us`, or `@lid` with/without `senderPhone`) and put it in `ALLOWED_SENDERS`.
The agent writes initial fixtures from the shapes above and makes the parse tests pass; the human's captures must also pass.

---------------------------------------------------------------------------------------------------

## 3. Configuration (`config.ts`)

Parse `process.env` with zod at startup; on failure print every problem (names only, never values) and exit 1.
Provide `bot/.env.example` with all keys and no real values.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `3000` | Bind to `127.0.0.1` unless `HOST` is set (a reverse proxy terminates TLS). |
| `HOST` | no | `127.0.0.1` | |
| `OPENWA_FLAVOR` | yes | | `openwa-gateway` or `wa-automate`. |
| `WEBHOOK_PATH_TOKEN` | yes | | >= 24 random chars. Used as the URL path segment `/webhook/<token>` (both flavors). |
| `WEBHOOK_HMAC_SECRET` | yes for `openwa-gateway` | | >= 16 chars; must equal the `secret` the webhook was registered with. |
| `WEBHOOK_PUBLIC_URL` | only for the register script | | Public HTTPS URL of `/webhook/<token>`. |
| `OPENWA_SESSION_ID` | yes for `openwa-gateway` | | Gateway session the bot talks to; events from other sessions are ignored. |
| `TYPING_INDICATOR` | no | `false` | `openwa-gateway` only: send `typing` before answering and `paused` after. Failures ignored. |
| `OPENWA_BASE_URL` | yes | | e.g. `https://wa.example.com:2785` (no trailing slash). |
| `OPENWA_API_KEY` | yes | | |
| `OPENWA_API_KEY_HEADER` | no | `X-API-Key` (openwa-gateway) / `api_key` (wa-automate, VERIFY) | |
| `OPENWA_SEND_TEXT_PATH` | no | `/api/sessions/{sessionId}/messages/send-text` (openwa-gateway) / `/sendText` (wa-automate) | `{sessionId}` is substituted (URL-encoded). |
| `ALLOWED_SENDERS` | yes | | `ownerId:chatId` pairs, comma separated, see section 6. |
| `DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME` | yes (port optional) | 3306 | Use a SELECT-only user. |
| `DB_SSL` / `DB_SSL_CA` | no | off | If `DB_SSL=true`, pass `ssl` to the library (Phase 1, 2.3); `DB_SSL_CA` is a path to a CA file. |
| `GEMINI_API_KEY` | yes | | |
| `GEMINI_MODEL` | yes | | No default in code; see Phase 1 section 0. |
| `ENRICHMENT_PATH` | no | `./.nlsql/enrichment.json` | |
| `EXPORT_*` | yes for export | | Per Phase 2 section 2.8; if `EXPORT_BASE_URL` is unset the `/csv` feature is disabled with a clear reply. |
| `TZ` | no | `Africa/Nairobi` | Set `process.env.TZ` before anything else; affects "today"/"last month". |
| `LOCALE` | no | `en-US` | Number formatting. |
| `MAX_MESSAGE_AGE_SEC` | no | `120` | Older messages are dropped (open-wa can replay after reconnect). |
| `RATE_LIMIT_PER_MIN` | no | `10` | Per chat. |
| `DAILY_QUERY_LIMIT` | no | `200` | Global LLM-cost guard; resets at local midnight. |
| `CAPTURE_MODE` | no | off | Section 2. |
| `LOG_LEVEL` | no | `info` | |

---------------------------------------------------------------------------------------------------

## 4. Gateway adapter (`src/gateway/`)

### 4.1 Common interface (`types.ts`)
```ts
interface InboundMessage {
  id: string; dedupeKey: string; chatId: string; senderId: string; senderPhone?: string;   // senderPhone: digits only
  text: string; isGroup: boolean; fromMe: boolean; type: string; timestampMs: number;
}
type ParseResult =
  | { kind: 'message'; msg: InboundMessage }
  | { kind: 'ignore' }                       // valid delivery we do not act on (other event/session/type)
  | { kind: 'reject'; status: 400 | 401 };   // bad signature or malformed body
interface GatewayAdapter {
  parse(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParseResult;  // verifies + parses; never throws
  sendText(chatId: string, text: string): Promise<void>;                                         // chunks > 3800 chars
  sendTyping?(chatId: string, state: 'typing' | 'paused'): Promise<void>;
}
```
`createGateway(config)` returns the adapter for `OPENWA_FLAVOR`. The router depends only on this interface (and tests use a fake).
Both flavors use Node's built-in `fetch` (Node >= 20), 15 s timeout (`AbortSignal.timeout`), and never put the API key or HMAC secret in errors or logs.

### 4.2 Flavor `openwa-gateway` (`openwa.ts`)
`parse(rawBody, headers)`:
1. If `WEBHOOK_HMAC_SECRET` is set (it is required for this flavor): compute `'sha256=' + hmacSha256Hex(secret, rawBody)`; compare with header `x-openwa-signature` using
   length check then `crypto.timingSafeEqual`. Missing/malformed/wrong -> `{ kind:'reject', status:401 }`. Do this BEFORE `JSON.parse` (`signature.ts`, unit-tested with the vectors from the OpenWA example doc).
2. `JSON.parse` in try/catch -> `reject 400` on failure.
3. `event !== 'message.received'` -> `ignore`. `sessionId !== OPENWA_SESSION_ID` -> `ignore`.
4. From `data`: `id` (string; if object use `_serialized`); `text` = `data.body` only when `data.type === 'text'` and body is a non-empty string, else `ignore`;
   `chatId = data.chatId ?? data.from`; `senderId = data.author ?? data.from`; `senderPhone = digits-only string if data.senderPhone is a non-empty string`;
   `isGroup = data.isGroup === true || data.kind === 'group' || chatId.endsWith('@g.us')`; `ignore` when `data.kind` is `status`, `broadcast` or `channel`;
   `fromMe = data.fromMe === true`; `timestampMs = Number(data.timestamp) * 1000` (epoch SECONDS; if the value is already >= 1e12 treat it as ms; if missing use `Date.now()`).
5. `dedupeKey` = header `x-openwa-idempotency-key`, else `` `msg_${sessionId}_${id}` ``.
`sendText`:
- `POST ${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, headers `{ 'X-API-Key': key, 'content-type': 'application/json' }`, body `{ chatId, text }`. Success = any 2xx (expect 201).
- Retry policy: `409` (engine not ready) up to 3 times, backoff 1 s / 3 s / 6 s; `429` with `code === 'SEND_PACING_LIMITED'`: wait `retryAfterSeconds` (cap 10 s) and retry once; `5xx` and network errors up to 2 times (500 ms / 1.5 s);
  other `4xx` (400/401/403/404) never retried. Throw `GatewayError` with status and a 200-char truncated body.
`sendTyping`: `POST .../chats/typing { chatId, state }`; swallow all errors.

### 4.3 Flavor `wa-automate` (`waAutomate.ts`) — unverified, keep configurable
`parse` ignores signatures (none documented). Accept wrapped `{ event, data }` and bare message objects; `event` present and not `onMessage` -> `ignore`.
`id` = `data.id` (or `_serialized`); `text` = `data.body` when `data.type` is `'chat'` (or absent); `chatId = data.chatId ?? data.from`; `senderId = data.sender?.id ?? data.author ?? data.from`;
`isGroup = data.isGroupMsg === true || chatId.endsWith('@g.us')`; `fromMe = data.fromMe === true`; timestamp from `data.t` or `data.timestamp` (< 1e12 means seconds); `dedupeKey = id`.
`sendText`: `POST ${baseUrl}${OPENWA_SEND_TEXT_PATH}` JSON `{ args: { to: chatId, content: text } }`, header `[OPENWA_API_KEY_HEADER]: key`; success = 2xx and body not `{ success: false }`; same retry policy for 5xx/network, none for 4xx.

### 4.4 Fixtures and tests (`tests/fixtures/<flavor>/`)
- openwa-gateway: signed text DM; same body with a wrong/missing signature (-> reject 401); `session.status` event (ignore); other `sessionId` (ignore); `type:'image'` (ignore); `kind:'status'` (ignore);
  group message; `fromMe:true`; LID sender with and without `senderPhone`; `timestamp` in seconds; retry delivery with the same idempotency key.
- wa-automate: text DM wrapped and bare; group; `fromMe`; image; garbage JSON.

---------------------------------------------------------------------------------------------------

## 5. Webhook server (`server.ts`, Fastify)

Raw body: register `server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => done(null, body))` so the route receives the exact bytes
(required for HMAC verification; never re-serialize). Body limit 1 MB (matches the gateway's default `WEBHOOK_MAX_PAYLOAD_BYTES`).

Routes:
- `POST /webhook/:token`
  - Compare `:token` with `WEBHOOK_PATH_TOKEN`: hash both with SHA-256, `crypto.timingSafeEqual`. Mismatch -> `404` with an empty body (do not reveal the route exists).
  - `CAPTURE_MODE` -> capture only (section 2.3).
  - `result = gateway.parse(req.body, req.headers)`: `reject` -> reply with that status (401/400); `ignore` -> `200 {"ok":true}`; `message` -> next step.
  - Dedupe on `msg.dedupeKey` (LRU of the last 500 keys, shared with section 6). Duplicate -> `200 {"ok":true}` and stop. (The gateway is at-least-once and retries on non-2xx or after 10 s without a response.)
  - Respond `200 {"ok":true}` IMMEDIATELY, then process asynchronously (`setImmediate` with a catch that logs). The gateway must never wait for Gemini or MySQL: its delivery timeout is 10 s.
- `GET /healthz` -> `{ ok: true, db: boolean, uptimeSec }`; `db` is a cached (30 s) `SELECT 1` through the library client. No secrets, no config.
- All other routes 404 with no detail.
- Logging: request logging OFF for `/webhook/*` (the token is in the URL); redact `req.url` there. Never log message text above `debug`, never log `x-openwa-signature`.

---------------------------------------------------------------------------------------------------

## 6. Access control (`access.ts`)

`ALLOWED_SENDERS` format: `david:254712345678@c.us,david:98765432101234@lid` (comma-separated `ownerId:chatId`; several ids may map to one ownerId,
because WhatsApp may deliver the same person as a phone id or as a `@lid` id).
- `ownerId` must match the Phase 2 regex `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`; validate at startup, exit on invalid.
- A message is accepted only if one of `chatId`, `senderId`, or (when present) `` `${senderPhone}@c.us` `` exactly matches an allowlisted id AND `isGroup === false` AND `fromMe === false`.
  With the OpenWA gateway, set `RESOLVE_LID_TO_PHONE=true` on the gateway so `@lid` senders arrive with `senderPhone`; then the allowlist can stay phone-based.
- Unknown senders: no reply, no processing. Log once per distinct sender at `warn`: `ignored unknown sender <masked id>` (mask all but the last 4 chars).
  Setup aid: if `LOG_LEVEL=debug`, log the full id so the owner can copy it into `ALLOWED_SENDERS`.
- Drop: non-`chat` types, empty text after trim, messages older than `MAX_MESSAGE_AGE_SEC`, duplicate `dedupeKey`s (the LRU from section 5).
- Cap incoming text at 1000 chars (longer -> reply "That message is too long. Please shorten it.").

---------------------------------------------------------------------------------------------------

## 7. Message handling (`router.ts`, `commands.ts`, `state.ts`)

### 7.1 State (`state.ts`)
`ChatState { turns: ConversationTurn[] (max 3); lastQuery: { question; sql } | null; lastSeen: number; queue: Promise<void> }` in a `Map<chatId, ChatState>`.
Evict entries idle > 2 h; cap the map at 100 chats (evict least recently seen). Store NO result rows, only columns/rowCount/summary text.
`RateLimiter`: sliding window per chat (`RATE_LIMIT_PER_MIN`) plus a global daily counter (`DAILY_QUERY_LIMIT`). Only commands that call the LLM or DB count.

### 7.2 Per-chat serialization
`handleInbound` appends work to `state.queue` so messages from one chat are processed in order. Global concurrency cap 2 (simple semaphore).
Errors are caught per message; the chain never rejects.

### 7.3 Flow
```
handleInbound(msg):
  access checks (6) -> else return
  text = msg.text.trim()
  if text starts with '/'  -> commands.run(...)           (7.4)
  intent = detectExportIntent(text)                       (Phase 2, 2.9)
  if intent:  handleExport(intent)                        (9)
  else:       handleQuestion(text)
handleQuestion(text):
  rate limit check -> reply "Slow down a little, try again in a minute." / "Daily limit reached."
  start ack timer: if not finished in 4 s, send "Working on it..." once
  result = await client.query(text, { history: state.turns, summarize: true, summaryMaxChars: 600, maxRetries: 2,
                                      fewShotExamples, currentDate })
  if result.error: reply friendlyError(result)            (8.3); do not add a turn
  else: reply formatAnswer(result) (8); push turn { question, sql, resultColumns, rowCount, summary }; trim to 3;
        state.lastQuery = { question: text, sql: result.sql }
```
Wrap everything in try/catch: unexpected errors -> log with message id (not text) and reply "Something went wrong. Please try again."
If `sendText` itself fails, log and give up (no infinite retry loops, no recursive error replies).

### 7.4 Commands (`commands.ts`, pure parser + handlers)
| Command | Behaviour |
|---|---|
| `/help` | Short usage text: ask in plain language; examples; list of commands. |
| `/tables` | List `businessName (tableName)` for enriched tables from `client.getEnrichedSchema()`, max 40 lines. |
| `/sql` | Reply with `state.lastQuery.sql` in a code block, or "No query yet." |
| `/csv` | Same as intent `last` (section 9). |
| `/reset` | Clear `turns` and `lastQuery`. |
| `/refresh` | Re-run enrichment: ack "Refreshing schema, this can take a few minutes...", `await client.enrich({ forceRefresh: false })` (use `true` for `/refresh all`), then reply with `enriched/skipped/failed` counts. Only one refresh at a time; second call replies "A refresh is already running." |
Unknown command -> "Unknown command. Send /help." Commands are case-insensitive and trim trailing text.

### 7.5 Few-shot examples
At startup, if `config/examples.json` exists: parse (zod: array of `{question, sql}`), validate each `sql` with `client.validateSQL` and drop/log invalid ones.
Pass the valid list as `fewShotExamples` to every `query()`. Missing file is fine.

---------------------------------------------------------------------------------------------------

## 8. Formatting (`format.ts`) — pure functions, snapshot-tested

WhatsApp renders `*bold*`, `_italic_` and triple-backtick blocks (monospace). No markdown tables, no HTML.

### 8.1 `formatAnswer(result: QueryResult, opts): string`
Compose, in order, joined by blank lines:
1. `result.summary` (if present).
2. A table block only when it adds value: `rowCount >= 2` or the summary is missing. Max 10 rows and 4 columns shown
   (extra columns dropped with `+N more columns`). Render inside triple backticks with space-padded aligned columns, header row, a dashed separator;
   cell text cut to 18 chars with `…`; numbers right-aligned and formatted with `Intl.NumberFormat(LOCALE)` (do not reformat ids/phone-like strings:
   only format values that were JS numbers, or numeric strings from decimal/bigint columns that are not named like `id`/`*_id`/`phone*`).
3. Footer lines as needed: `Showing 10 of {rowCount} rows.` when rows were cut; `Result limited to {maxRows} rows.` when `result.truncated`;
   `Reply "csv" for the full result as a file.` when `rowCount > 10` or truncated (and export is enabled).
Single row/single column and a summary exists -> summary only (no table).
Zero rows -> `No matching records found.`
Total length hard cap 3500 chars: drop the table first, then shorten the summary.

### 8.2 Escaping
Values inside the code block cannot contain triple backticks: replace `` ` `` with `'` in cell text. Strip control characters. Never place raw DB text outside a code block
without removing leading `*`/`_`/`~` formatting characters (replace with a zero-width space or escape by removing them).

### 8.3 `friendlyError(result): string`
Map by cause; never leak SQL errors, stack traces, host names or table names beyond the validator's short reason:
- LLM said unable (`-- UNABLE_TO_ANSWER`): "I can't answer that from the available data: {reason}".
- Validation rejected after retries: "I couldn't build a safe query for that. Try rephrasing."
- DB timeout: "That query took too long. Try narrowing it (for example a date range)."
- Gemini/network failure: "The AI service is unavailable right now. Please try again shortly."
- Otherwise: "I couldn't answer that. Try rephrasing."
(`QueryResult.error` is a string today; if finer causes are needed, add an optional `errorKind` to `QueryResult` in the library as part of section 11.)

---------------------------------------------------------------------------------------------------

## 9. Export wiring (uses Phase 2)

- Construct `CsvExportService(client, loadExportConfigFromEnv())` at startup if export is configured; `startCleanupTimer(config)`.
- `handleExport(intent)`:
  - `kind:'last'`: need `state.lastQuery`; none -> "Ask a question first, then reply `csv`."
  - `kind:'new'`: run `handleQuestion`-style `client.query(intent.question, { ...same options, summarize: false })`; on success export `result.sql`;
    reply with the normal short answer first only if the table is small, otherwise just the export message.
  - Ack "Preparing your export..." if it has not finished in 4 s. Rate limit counts as one query.
  - Call `exportService.export({ ownerId, sql, question })`; ownerId comes from the allowlist match (section 6), never from the chat id.
- Reply texts per Phase 2 section 4. Do not paste the URL anywhere except in the reply to the owner.
- If export is disabled: "CSV export isn't set up yet."

---------------------------------------------------------------------------------------------------

## 10. Startup, shutdown, logging

Startup order: config -> logger -> `new NLSQLClient(...)` -> `await client.initialise({ forceRefresh: false })` (enriches only new/changed tables; log the summary)
-> export service + cleanup timer -> few-shot examples -> `server.listen` -> log "ready" (no secrets).
If MySQL or enrichment fails at startup: log and exit 1 (let the process manager restart with backoff).
Shutdown on `SIGTERM`/`SIGINT`: stop accepting webhooks (Fastify `close`), wait up to 10 s for in-flight handlers, stop timers, `client.close()`, exit 0.
Logging (pino): JSON in production, `pino-pretty` only in dev. Info-level fields: `msgId`, `ownerId`, `attempts`, `rowCount`, `timing`, `errorKind`.
Never log: message text (debug only), SQL (debug only), result rows, API keys, webhook secret, DB password. Add a redact list for these keys.
`process.on('unhandledRejection'/'uncaughtException')`: log and exit 1.

---------------------------------------------------------------------------------------------------

## 11. Small library deltas needed by the bot (do these first, in `src/`)

- `QueryOptions.currentDate?: string` (ISO `YYYY-MM-DD`; default today in the process timezone) passed through to `GenerateSQLInput.currentDate`.
  (Phase 1 defined the field on the LLM input but no way for callers to set or default it.)
- Optional: `QueryResult.errorKind?: 'unable' | 'rejected' | 'timeout' | 'llm' | 'db' | 'config'` set by `query()`; add tests.
Both are backwards compatible.

---------------------------------------------------------------------------------------------------

## 12. Tests (bot/tests, Jest)

- `gateway.test.ts` (per flavor): section 4.4 fixtures; `signature.test.ts`: valid, wrong, missing, truncated, wrong-prefix and length-mismatch headers (must return false, never throw).
- `access.test.ts`: allowlist parsing (valid/invalid ownerId, multiple ids per owner), group/fromMe/unknown rejected, `@lid` accepted when listed, old message dropped, duplicate id dropped, too-long text.
- `server.test.ts` (Fastify `inject`; for openwa-gateway sign bodies with the test secret): wrong path token -> 404 empty; bad signature -> 401; `ignore` result -> 200 without calling the router; duplicate idempotency key processed once; right secret returns 200 before the handler finishes (handler stubbed with a slow promise); body > 1 MB rejected;
  `/healthz` has no secrets; capture mode writes a file and sends nothing.
- `sender.test.ts`: tiny local `http.createServer` as a fake gateway, per flavor: asserts path, auth header and body (openwa-gateway: `POST /api/sessions/<id>/messages/send-text` with `X-API-Key` and `{chatId,text}`; wa-automate: `{args:{to,content}}`);
  openwa-gateway retries `409` and `5xx`, honours `429 SEND_PACING_LIMITED` `retryAfterSeconds`, never retries `400/401/404`; timeout; API key never appears in thrown errors; long text split; `sendTyping` errors swallowed.
- `router.test.ts` with fakes (`FakeClient`, `FakeMessenger`, fake clock): question -> answer sent and turn stored (max 3); follow-up passes `history`; error not stored as a turn;
  `/sql`, `/reset`, `/tables`, `/help`, `/refresh` (single-flight); `csv` with and without `lastQuery`; "export x as csv" runs a new query then exports;
  ack message after 4 s only when slow; rate limit and daily limit replies; per-chat ordering (two quick messages answered in order);
  `sendText` failure does not crash or loop.
- `format.test.ts` (snapshots): single value, small table, wide table (+N more columns), 10+ rows footer, truncated footer, zero rows, long cell, backtick/markup in data, 3500-char cap, number formatting not applied to id columns.
- Integration (skipped unless `DB_HOST` and `GEMINI_API_KEY` are set): start the app against `shop_sample.sql` with a fake open-wa HTTP server; POST a webhook fixture;
  assert exactly one `sendText` call with a non-empty answer.

---------------------------------------------------------------------------------------------------

## 13. Notes for the human (put in `bot/README.md`, agent does not execute)

- The gateway can send messages as your WhatsApp account: keep its API key secret, restrict network access to the bot host if possible, and never expose it publicly without the key.
- OpenWA gateway specifics: the Docker image writes the API key to `/app/data/.api-key`; webhook URLs on private/loopback addresses are rejected at registration unless `SSRF_ALLOWED_HOSTS` allows them; the webhook `secret` must be >= 16 chars and identical in the gateway and `WEBHOOK_HMAC_SECRET`; set `RESOLVE_LID_TO_PHONE=true` on the gateway.
- Both gateways are unofficial (they drive WhatsApp Web). Accounts can be restricted; keep the bot's reply volume low and only to you.
- With `wa-automate` the webhook is authenticated only by the token in the URL; with `openwa-gateway` it is also HMAC-signed. Either way serve the bot over HTTPS (Caddy/nginx in front, bot on 127.0.0.1) and use a long random `WEBHOOK_PATH_TOKEN`.
- Run under systemd or PM2 with restart-on-failure; `GET /healthz` can be monitored.
- Use a MySQL user with `GRANT SELECT` only; allow the bot host in MySQL's host rules and use TLS if the DB is remote.
- Everything the schema enrichment and your questions contain is sent to Google (Gemini). Use `schema.excludeTables/excludeColumns` (Phase 1) for sensitive data.
- WhatsApp may identify you with a `@lid` id instead of your phone id; add whichever id appears in the logs to `ALLOWED_SENDERS`.

---------------------------------------------------------------------------------------------------

## 14. Execution order and definition of done

Order: 11 (library deltas) -> 1 (scaffold) -> 3 (config) -> 4 (gateway adapters) -> 6 (access) -> 5 (server + capture mode) -> 7 (state, router, commands) -> 8 (format) -> 9 (export wiring) -> 10 (startup/shutdown) -> 12 (tests) -> 13 (README).

Done when:
- Root and `bot/` `npm run lint` and `npm test` pass; `npm run build` works from a clean clone (`npm ci` in root, then in `bot/`).
- Both adapters pass the agent-written fixtures, and the human's real captures pass the adapter for their flavor.
- With a fake open-wa server and the sample database, one webhook fixture produces exactly one `sendText` with a correct answer; a follow-up
  ("now only gold tier") produces valid SQL using history; `csv` produces a file in `EXPORT_ROOT_DIR` and a reply containing the URL.
- Webhook handler returns 200 in under 100 ms regardless of LLM/DB latency.
- Unknown senders, groups, own messages, replayed/old messages and duplicates produce no reply.
- No secret or message text appears in logs at `info`.
- Manual E2E checklist (human): captured real payload parses; allowlisted phone gets an answer within ~10 s; `csv` link downloads through the web app.
