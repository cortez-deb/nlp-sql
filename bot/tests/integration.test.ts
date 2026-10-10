import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  NLSQLClient,
  CsvExportService,
  loadExportConfigFromEnv,
  type NLSQLClientConfig,
} from 'nlsql';
import { OpenWAGatewayAdapter } from '../src/gateway/openwa';
import { AccessController } from '../src/access';
import { ChatStateStore, RateLimiter, Semaphore } from '../src/state';
import { MessageRouter } from '../src/router';
import { buildServer } from '../src/server';
import type { BotConfig } from '../src/config';

// Try loading root .env
const rootEnvPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(rootEnvPath)) {
  const content = fs.readFileSync(rootEnvPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const isIntegrationEnabled =
  Boolean(process.env.DB_HOST) &&
  Boolean(process.env.GEMINI_API_KEY) &&
  Boolean(process.env.GEMINI_MODEL);

(isIntegrationEnabled ? describe : describe.skip)(
  'Bot End-to-End Integration (Live DB & Gemini)',
  () => {
    let fakeGatewayServer: http.Server;
    let fakeGatewayUrl: string;
    const receivedSends: any[] = [];
    let appServer: any;
    let client: NLSQLClient;

    const secret = 'integration-test-secret-16-bytes';
    const token = '123456789012345678901234';

    beforeAll(async () => {
      // 1. Fake OpenWA Gateway Server
      await new Promise<void>((resolve) => {
        fakeGatewayServer = http.createServer((req, res) => {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            if (req.url?.includes('send-text')) {
              try {
                receivedSends.push(JSON.parse(body));
              } catch {
                receivedSends.push({ raw: body });
              }
              res.statusCode = 201;
              res.end(JSON.stringify({ messageId: 'int_msg_1' }));
            } else {
              res.statusCode = 200;
              res.end('{}');
            }
          });
        });
        fakeGatewayServer.listen(0, '127.0.0.1', () => {
          const addr = fakeGatewayServer.address() as any;
          fakeGatewayUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });

      // 2. Client setup
      const clientConfig: NLSQLClientConfig = {
        db: {
          host: process.env.DB_HOST!,
          port: Number(process.env.DB_PORT ?? 3306),
          user: process.env.DB_USER ?? 'root',
          password: process.env.DB_PASSWORD ?? '',
          database: process.env.DB_NAME ?? 'shop',
        },
        llm: {
          provider: 'gemini',
          apiKey: process.env.GEMINI_API_KEY!,
          model: process.env.GEMINI_MODEL!,
        },
        storage: {
          type: 'file',
          path: './.nlsql/enrichment.json',
        },
      };

      client = new NLSQLClient(clientConfig);
      await client.initialise({ forceRefresh: false });

      // 3. Bot Config
      const botConfig: BotConfig = {
        PORT: 0,
        HOST: '127.0.0.1',
        OPENWA_FLAVOR: 'openwa-gateway',
        WEBHOOK_PATH_TOKEN: token,
        WEBHOOK_HMAC_SECRET: secret,
        OPENWA_SESSION_ID: 'int-session',
        OPENWA_BASE_URL: fakeGatewayUrl,
        OPENWA_API_KEY: 'test-api-key',
        apiKeyHeader: 'X-API-Key',
        sendTextPath: '/api/sessions/{sessionId}/messages/send-text',
        ALLOWED_SENDERS: 'david:254712345678@c.us',
        DB_HOST: process.env.DB_HOST!,
        DB_PORT: Number(process.env.DB_PORT ?? 3306),
        DB_USER: process.env.DB_USER ?? 'root',
        DB_PASSWORD: process.env.DB_PASSWORD ?? '',
        DB_NAME: process.env.DB_NAME ?? 'shop',
        DB_SSL: false,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY!,
        GEMINI_MODEL: process.env.GEMINI_MODEL!,
        ENRICHMENT_PATH: './.nlsql/enrichment.json',
        EXPORT_DOWNLOAD_DIR: '/var/www/downloads',
        EXPORT_RETENTION_HOURS: 24,
        EXPORT_MAX_ROWS: 100000,
        TZ: 'Africa/Nairobi',
        LOCALE: 'en-US',
        MAX_MESSAGE_AGE_SEC: 120,
        RATE_LIMIT_PER_MIN: 10,
        DAILY_QUERY_LIMIT: 200,
        CAPTURE_MODE: false,
        LOG_LEVEL: 'info',
        TYPING_INDICATOR: false,
      };

      const gateway = new OpenWAGatewayAdapter(botConfig);
      const accessController = new AccessController(botConfig.ALLOWED_SENDERS);
      const stateStore = new ChatStateStore();
      const rateLimiter = new RateLimiter();
      const semaphore = new Semaphore(2);

      let exportService: CsvExportService | null = null;
      if (process.env.EXPORT_BASE_URL) {
        try {
          const expConfig = loadExportConfigFromEnv(process.env);
          exportService = new CsvExportService(client, expConfig);
        } catch {
          // ignore
        }
      }

      const router = new MessageRouter({
        config: botConfig,
        client,
        gateway,
        accessController,
        stateStore,
        rateLimiter,
        semaphore,
        exportService,
      });

      appServer = buildServer({
        config: botConfig,
        gateway,
        accessController,
        dedupeLru: accessController.dedupeLru,
        onMessage: (msg) => router.handleInbound(msg),
        checkDb: async () => true,
      });
    }, 30000);

    afterAll(async () => {
      if (appServer) await appServer.close();
      if (fakeGatewayServer) {
        await new Promise((r) => fakeGatewayServer.close(r));
      }
      if (client) await client.close();
    });

    it('processes webhook payload and sends answer via fake OpenWA server', async () => {
      receivedSends.length = 0;

      const payload = {
        event: 'message.received',
        timestamp: new Date().toISOString(),
        sessionId: 'int-session',
        idempotencyKey: 'int_idemp_001',
        data: {
          id: 'msg_int_001',
          chatId: '254712345678@c.us',
          from: '254712345678@c.us',
          body: 'How many total products exist in the store?',
          type: 'text',
          timestamp: Math.floor(Date.now() / 1000),
          isGroup: false,
          kind: 'individual',
          fromMe: false,
        },
      };

      const raw = Buffer.from(JSON.stringify(payload));
      const sigHex = crypto.createHmac('sha256', secret).update(raw).digest('hex');

      const res = await appServer.inject({
        method: 'POST',
        url: `/webhook/${token}`,
        payload: raw,
        headers: {
          'content-type': 'application/json',
          'x-openwa-signature': `sha256=${sigHex}`,
        },
      });

      expect(res.statusCode).toBe(200);

      // Wait for LLM + DB query to complete and sendText to fire
      const maxWait = 15000;
      const start = Date.now();
      while (receivedSends.length === 0 && Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 200));
      }

      expect(receivedSends.length).toBe(1);
      expect(receivedSends[0].chatId).toBe('254712345678@c.us');
      expect(receivedSends[0].text).toBeTruthy();
      expect(receivedSends[0].text.length).toBeGreaterThan(0);
    }, 20000);
  }
);
