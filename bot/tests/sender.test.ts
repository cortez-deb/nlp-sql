import http from 'http';
import { OpenWAGatewayAdapter } from '../src/gateway/openwa';
import { WAAutomateGatewayAdapter } from '../src/gateway/waAutomate';
import { GatewayError } from '../src/gateway/types';
import type { BotConfig } from '../src/config';

describe('Gateway Senders', () => {
  let server: http.Server;
  let serverUrl: string;
  let requestHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      if (requestHandler) {
        requestHandler(req, res);
      } else {
        res.statusCode = 200;
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      serverUrl = `http://127.0.0.1:${addr.port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  const baseConfig: BotConfig = {
    PORT: 3000,
    HOST: '127.0.0.1',
    OPENWA_FLAVOR: 'openwa-gateway',
    WEBHOOK_PATH_TOKEN: '123456789012345678901234',
    WEBHOOK_HMAC_SECRET: 'super-secret-hmac-16-bytes',
    OPENWA_SESSION_ID: 'sess-123',
    OPENWA_BASE_URL: '',
    OPENWA_API_KEY: 'test-api-secret-key-999',
    apiKeyHeader: 'X-API-Key',
    sendTextPath: '/api/sessions/{sessionId}/messages/send-text',
    ALLOWED_SENDERS: 'david:254712345678@c.us',
    DB_HOST: 'localhost',
    DB_PORT: 3306,
    DB_USER: 'root',
    DB_PASSWORD: '',
    DB_NAME: 'shop',
    DB_SSL: false,
    GEMINI_API_KEY: 'test-gemini',
    GEMINI_MODEL: 'gemini-3.5-flash-lite',
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
    TYPING_INDICATOR: true,
  };

  describe('openwa-gateway sender', () => {
    it('sends text with correct path, headers and body', async () => {
      let receivedPath = '';
      let receivedAuth = '';
      let receivedBody = '';

      requestHandler = (req, res) => {
        receivedPath = req.url || '';
        receivedAuth = req.headers['x-api-key'] as string;
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          receivedBody = body;
          res.statusCode = 201;
          res.end(JSON.stringify({ messageId: 'm1', timestamp: 1234 }));
        });
      };

      const adapter = new OpenWAGatewayAdapter({
        ...baseConfig,
        OPENWA_BASE_URL: serverUrl,
      });

      await adapter.sendText('254712345678@c.us', 'Hello world');

      expect(receivedPath).toBe('/api/sessions/sess-123/messages/send-text');
      expect(receivedAuth).toBe('test-api-secret-key-999');
      const parsed = JSON.parse(receivedBody);
      expect(parsed).toEqual({
        chatId: '254712345678@c.us',
        text: 'Hello world',
      });
    });

    it('splits long text > 3800 characters into multiple chunks', async () => {
      const receivedChunks: string[] = [];

      requestHandler = (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          receivedChunks.push(parsed.text);
          res.statusCode = 201;
          res.end(JSON.stringify({ messageId: 'm1' }));
        });
      };

      const adapter = new OpenWAGatewayAdapter({
        ...baseConfig,
        OPENWA_BASE_URL: serverUrl,
      });

      const longMsg = 'a'.repeat(4000);
      await adapter.sendText('254712345678@c.us', longMsg);

      expect(receivedChunks.length).toBeGreaterThanOrEqual(2);
      expect(receivedChunks[0].length).toBeLessThanOrEqual(3800);
    });

    it('retries on 409 engine not ready', async () => {
      let attempts = 0;
      requestHandler = (_req, res) => {
        attempts++;
        if (attempts < 2) {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: 'Engine not ready' }));
        } else {
          res.statusCode = 201;
          res.end(JSON.stringify({ messageId: 'ok' }));
        }
      };

      const adapter = new OpenWAGatewayAdapter({
        ...baseConfig,
        OPENWA_BASE_URL: serverUrl,
      });

      await adapter.sendText('254712345678@c.us', 'Retry 409');
      expect(attempts).toBe(2);
    });

    it('honours 429 SEND_PACING_LIMITED retryAfterSeconds', async () => {
      let attempts = 0;
      requestHandler = (_req, res) => {
        attempts++;
        if (attempts === 1) {
          res.statusCode = 429;
          res.end(
            JSON.stringify({
              code: 'SEND_PACING_LIMITED',
              retryAfterSeconds: 1,
            })
          );
        } else {
          res.statusCode = 201;
          res.end(JSON.stringify({ messageId: 'ok' }));
        }
      };

      const adapter = new OpenWAGatewayAdapter({
        ...baseConfig,
        OPENWA_BASE_URL: serverUrl,
      });

      await adapter.sendText('254712345678@c.us', 'Paced');
      expect(attempts).toBe(2);
    });

    it('never retries on 400 or 401 and does not leak API key in error message', async () => {
      let attempts = 0;
      requestHandler = (_req, res) => {
        attempts++;
        res.statusCode = 401;
        res.end(JSON.stringify({ message: 'Unauthorized key' }));
      };

      const adapter = new OpenWAGatewayAdapter({
        ...baseConfig,
        OPENWA_BASE_URL: serverUrl,
      });

      let caughtErr: any;
      try {
        await adapter.sendText('254712345678@c.us', 'Auth fail');
      } catch (err) {
        caughtErr = err;
      }

      expect(attempts).toBe(1);
      expect(caughtErr).toBeInstanceOf(GatewayError);
      expect(caughtErr.statusCode).toBe(401);
      expect(caughtErr.message).not.toContain('test-api-secret-key-999');
    });

    it('swallows sendTyping errors', async () => {
      requestHandler = (_req, res) => {
        res.statusCode = 500;
        res.end('Typing failed');
      };

      const adapter = new OpenWAGatewayAdapter({
        ...baseConfig,
        OPENWA_BASE_URL: serverUrl,
      });

      await expect(
        adapter.sendTyping!('254712345678@c.us', 'typing')
      ).resolves.not.toThrow();
    });
  });

  describe('wa-automate sender', () => {
    it('sends text with correct path, headers and body', async () => {
      let receivedPath = '';
      let receivedAuth = '';
      let receivedBody = '';

      requestHandler = (req, res) => {
        receivedPath = req.url || '';
        receivedAuth = req.headers['api_key'] as string;
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          receivedBody = body;
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true }));
        });
      };

      const adapter = new WAAutomateGatewayAdapter({
        ...baseConfig,
        OPENWA_FLAVOR: 'wa-automate',
        OPENWA_BASE_URL: serverUrl,
        apiKeyHeader: 'api_key',
        sendTextPath: '/sendText',
      });

      await adapter.sendText('254712345678@c.us', 'Hello WA Automate');

      expect(receivedPath).toBe('/sendText');
      expect(receivedAuth).toBe('test-api-secret-key-999');
      const parsed = JSON.parse(receivedBody);
      expect(parsed).toEqual({
        args: {
          to: '254712345678@c.us',
          content: 'Hello WA Automate',
        },
      });
    });

    it('throws when wa-automate returns success: false', async () => {
      requestHandler = (_req, res) => {
        res.statusCode = 200;
        res.end(JSON.stringify({ success: false, error: 'Failed to send' }));
      };

      const adapter = new WAAutomateGatewayAdapter({
        ...baseConfig,
        OPENWA_FLAVOR: 'wa-automate',
        OPENWA_BASE_URL: serverUrl,
        apiKeyHeader: 'api_key',
        sendTextPath: '/sendText',
      });

      await expect(
        adapter.sendText('254712345678@c.us', 'Fail test')
      ).rejects.toThrow();
    });
  });
});
