# nlsql-bot — WhatsApp Webhook Service for nlsql

`nlsql-bot` is a standalone HTTP webhook service that connects a self-hosted WhatsApp gateway (`openwa-gateway` or `wa-automate`) to `nlsql`. It receives inbound WhatsApp messages, answers natural language questions against your MySQL database using Google Gemini, formats answers cleanly for WhatsApp (tables and monospace markdown), enforces owner-only access controls, and serves signed CSV download links.

---

## 1. Quick Start & Setup

### Prerequisites
- Node.js >= 20
- MySQL database (with a `SELECT`-only user recommended)
- A running WhatsApp gateway instance (`openwa-gateway` or `wa-automate`)
- Google Gemini API key

### Installation & Build
```bash
# In repo root:
npm install
npm run build

# In bot directory:
cd bot
npm install
npm run build
```

---

## 2. Configuration

Copy `.env.example` to `.env` inside `bot/`:
```bash
cp .env.example .env
```

Key configuration parameters:
- `OPENWA_FLAVOR`: Set to `openwa-gateway` (verified NestJS gateway) or `wa-automate` (open-wa Easy API).
- `WEBHOOK_PATH_TOKEN`: Random string >= 24 chars for routing `/webhook/<token>`.
- `WEBHOOK_HMAC_SECRET`: Secret key >= 16 chars used by `openwa-gateway` to sign payloads (`X-OpenWA-Signature`).
- `ALLOWED_SENDERS`: Comma-separated `ownerId:chatId` pairs (e.g. `david:254712345678@c.us,david:98765432101234@lid`). Unknown senders are silently ignored.
- `DB_*`: Connection parameters to your MySQL database.
- `GEMINI_API_KEY` & `GEMINI_MODEL`: Gemini API credentials.
- `EXPORT_BASE_URL` & `EXPORT_DOWNLOAD_DIR`: URL and directory for CSV exports (Phase 2).

---

## 3. First-Run & Capture Mode

1. **Confirm Gateway Flavor & Endpoints**:
   - `openwa-gateway`: View `/api/docs` on your gateway port (default `2785`).
   - `wa-automate`: View `/api-docs/`.
   - Fill in `OPENWA_BASE_URL`, `OPENWA_API_KEY`, and `OPENWA_SESSION_ID`.

2. **Register the Webhook**:
   - For `openwa-gateway`, set `WEBHOOK_PUBLIC_URL` in `.env` (e.g. `https://bot.example.com/webhook/<token>`) and run:
     ```bash
     npm run register-webhook
     ```
   - For `wa-automate`, start the open-wa container or process with:
     ```bash
     -w https://bot.example.com/webhook/<WEBHOOK_PATH_TOKEN>
     ```

3. **Verify Incoming Payloads with Capture Mode**:
   - Set `CAPTURE_MODE=1` in `bot/.env`.
   - Start the bot (`npm run dev` or `npm start`).
   - Send "hello" from your WhatsApp phone to the bot's paired number.
   - The bot writes raw payloads to `bot/.capture/<timestamp>.json` and logs `Webhook payload captured` at info level, without processing or sending replies.
   - Inspect `.capture/*.json` to note whether your sender ID appears as `@c.us` or `@lid` (with or without `senderPhone`), and add it to `ALLOWED_SENDERS`.
   - Reset `CAPTURE_MODE=0` and restart the bot.

---

## 4. Usage & Commands

Send messages directly to the WhatsApp bot account from your allowlisted phone:

- **Ask Questions in Natural Language**:
  - *"How many orders were completed last month?"*
  - *"Who are our top 5 customers by revenue?"*
- **Follow-up Questions**:
  - *"Now filter that to only gold tier"* (the bot preserves context for up to 3 turns)
- **Export to CSV**:
  - Reply `csv` or `download as csv` to export the last query results to a CSV file.
  - Or ask directly: *"export all products as csv"*.
- **Slash Commands**:
  - `/help`: Display help and examples.
  - `/tables`: List available tables and their business descriptions.
  - `/sql`: View the SQL query generated for the last answer in a code block.
  - `/csv`: Export the last query results as CSV.
  - `/reset`: Clear conversational history and context.
  - `/refresh` / `/refresh all`: Re-run schema enrichment (single-flight).

---

## 5. Security & Operational Notes for Humans

- **Gateway Access**: The gateway drives a real WhatsApp Web session and can send messages as your account. Keep its API key strictly secret, restrict network access to the bot host, and never expose the gateway publicly without authentication.
- **OpenWA Gateway Specifics**:
  - In Docker, the gateway writes its API key to `/app/data/.api-key`.
  - Webhook URLs resolving to private or loopback IP addresses are rejected at registration unless `SSRF_ALLOWED_HOSTS` is configured on the gateway.
  - The webhook secret must be >= 16 characters and identical in the gateway and `WEBHOOK_HMAC_SECRET`.
  - Set `RESOLVE_LID_TO_PHONE=true` on the gateway so `@lid` senders include their phone numbers.
- **HTTPS & Reverse Proxy**:
  - Always serve the bot behind an HTTPS reverse proxy (e.g. Caddy or Nginx) binding to `127.0.0.1`.
  - Use a long, unpredictable `WEBHOOK_PATH_TOKEN`.
- **Database Hardening**:
  - Use a dedicated MySQL user granted only `SELECT` privileges:
    ```sql
    GRANT SELECT ON shop.* TO 'nlsql_user'@'bot_host';
    ```
- **Privacy & LLM**:
  - All schema definitions and user questions are sent to Google Gemini for SQL generation and summarization. Use `schema.excludeTables` and `schema.excludeColumns` in configuration if certain sensitive tables/columns should never be shared.
- **Process Supervision & Health Monitoring**:
  - Run the bot under `systemd` or `PM2` with automatic restart on failure.
  - Monitor `GET /healthz` for health checks (reports `{ ok: true, db: boolean, uptimeSec: number }` with zero secrets).
