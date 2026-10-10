import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { buildServer } from '../src/server';
import { OpenWAGatewayAdapter } from '../src/gateway/openwa';
import { AccessController, SimpleLru } from '../src/access';
import type { BotConfig } from '../src/config';

describe('Fastify Webhook Server', () => {
  const secret = 'webhook-hmac-secret-16-bytes';
  const token = '123456789012345678901234';
  const config: BotConfig = {
    PORT: 3000,
    HOST: '127.0.0.1',
    OPENWA_FLAVOR: 'openwa-gateway',
    WEBHOOK_PATH_TOKEN: token,
    WEBHOOK_HMAC_SECRET: secret,
    OPENWA_SESSION_ID: 'test-session',
    OPENWA_BASE_URL: 'http://localhost:2785',
    OPENWA_API_KEY: 'secret-key',
    apiKeyHeader: 'X-API-Key',
    sendTextPath: '/api/sessions/{sessionId}/messages/send-text',
    ALLOWED_SENDERS: 'david:254712345678@c.us',
    DB_HOST: 'localhost',
    DB_PORT: 3306,
    DB_USER: 'root',
    DB_PASSWORD: 'secret-db-password',
    DB_NAME: 'shop',
    DB_SSL: false,
    GEMINI_API_KEY: 'secret-gemini-key',
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
    TYPING_INDICATOR: false,
  };

  function signBody(raw: Buffer, s = secret): string {
    const hex = crypto.createHmac('sha256', s).update(raw).digest('hex');
    return `sha256=${hex}`;
  }

  it('wrong path token returns 404 with empty body', async () => {
    const gateway = new OpenWAGatewayAdapter(config);
    const accessController = new AccessController(config.ALLOWED_SENDERS);
    const server = buildServer({
      config,
      gateway,
      accessController,
      dedupeLru: accessController.dedupeLru,
      onMessage: async () => {},
      checkDb: async () => true,
    });

    const res = await server.inject({
      method: 'POST',
      url: '/webhook/wrong-token-1234567890123456',
      payload: Buffer.from('{}'),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('');
  });

  it('bad signature returns 401', async () => {
    const gateway = new OpenWAGatewayAdapter(config);
    const accessController = new AccessController(config.ALLOWED_SENDERS);
    const server = buildServer({
      config,
      gateway,
      accessController,
      dedupeLru: accessController.dedupeLru,
      onMessage: async () => {},
      checkDb: async () => true,
    });

    const raw = Buffer.from(
      JSON.stringify({ event: 'message.received', sessionId: 'test-session', data: {} })
    );
    const res = await server.inject({
      method: 'POST',
      url: `/webhook/${token}`,
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-openwa-signature': 'sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad',
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('ignore result returns 200 without calling the router', async () => {
    let handlerCalled = false;
    const gateway = new OpenWAGatewayAdapter(config);
    const accessController = new AccessController(config.ALLOWED_SENDERS);
    const server = buildServer({
      config,
      gateway,
      accessController,
      dedupeLru: accessController.dedupeLru,
      onMessage: async () => {
        handlerCalled = true;
      },
      checkDb: async () => true,
    });

    // Event session.status -> ignore
    const raw = Buffer.from(
      JSON.stringify({ event: 'session.status', sessionId: 'test-session', data: {} })
    );
    const res = await server.inject({
      method: 'POST',
      url: `/webhook/${token}`,
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-openwa-signature': signBody(raw),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // Allow any event loop cycles to run
    await new Promise((r) => setTimeout(r, 20));
    expect(handlerCalled).toBe(false);
  });

  it('duplicate idempotency key is processed only once', async () => {
    let handlerCount = 0;
    const gateway = new OpenWAGatewayAdapter(config);
    const dedupeLru = new SimpleLru<string, boolean>(500);
    const accessController = new AccessController(config.ALLOWED_SENDERS, 120, dedupeLru);
    const server = buildServer({
      config,
      gateway,
      accessController,
      dedupeLru,
      onMessage: async (_msg) => {
        handlerCount++;
      },
      checkDb: async () => true,
    });

    const raw = Buffer.from(
      JSON.stringify({
        event: 'message.received',
        sessionId: 'test-session',
        idempotencyKey: 'dup_idemp_key',
        data: {
          id: 'msg_1',
          type: 'text',
          body: 'Hello',
          chatId: '254712345678@c.us',
          from: '254712345678@c.us',
        },
      })
    );
    const headers = {
      'content-type': 'application/json',
      'x-openwa-signature': signBody(raw),
    };

    // First request
    const res1 = await server.inject({
      method: 'POST',
      url: `/webhook/${token}`,
      payload: raw,
      headers,
    });
    expect(res1.statusCode).toBe(200);

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 20));
    expect(dedupeLru.has('dup_idemp_key')).toBe(true);

    // Second request with same idempotency key
    const res2 = await server.inject({
      method: 'POST',
      url: `/webhook/${token}`,
      payload: raw,
      headers,
    });
    expect(res2.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 20));
    expect(handlerCount).toBe(1);
  });

  it('returns 200 before the handler finishes when handler is slow', async () => {
    let handlerFinished = false;
    const gateway = new OpenWAGatewayAdapter(config);
    const accessController = new AccessController(config.ALLOWED_SENDERS);
    const server = buildServer({
      config,
      gateway,
      accessController,
      dedupeLru: accessController.dedupeLru,
      onMessage: async () => {
        await new Promise((r) => setTimeout(r, 100));
        handlerFinished = true;
      },
      checkDb: async () => true,
    });

    const raw = Buffer.from(
      JSON.stringify({
        event: 'message.received',
        sessionId: 'test-session',
        idempotencyKey: 'slow_key_1',
        data: {
          id: 'msg_slow',
          type: 'text',
          body: 'Hello slow',
          chatId: '254712345678@c.us',
          from: '254712345678@c.us',
        },
      })
    );

    const res = await server.inject({
      method: 'POST',
      url: `/webhook/${token}`,
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-openwa-signature': signBody(raw),
      },
    });

    expect(res.statusCode).toBe(200);
    // Handler should NOT be finished yet!
    expect(handlerFinished).toBe(false);

    // Wait for it to complete
    await new Promise((r) => setTimeout(r, 150));
    expect(handlerFinished).toBe(true);
  });

  it('body > 1 MB is rejected', async () => {
    const gateway = new OpenWAGatewayAdapter(config);
    const accessController = new AccessController(config.ALLOWED_SENDERS);
    const server = buildServer({
      config,
      gateway,
      accessController,
      dedupeLru: accessController.dedupeLru,
      onMessage: async () => {},
      checkDb: async () => true,
    });

    const bigBody = Buffer.alloc(1024 * 1024 + 50, 'a');
    const res = await server.inject({
      method: 'POST',
      url: `/webhook/${token}`,
      payload: bigBody,
      headers: {
        'content-type': 'application/json',
      },
    });

    expect(res.statusCode).toBe(413);
  });

  it('/healthz returns status with no secrets', async () => {
    const gateway = new OpenWAGatewayAdapter(config);
    const accessController = new AccessController(config.ALLOWED_SENDERS);
    const server = buildServer({
      config,
      gateway,
      accessController,
      dedupeLru: accessController.dedupeLru,
      onMessage: async () => {},
      checkDb: async () => true,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(json.db).toBe(true);
    expect(typeof json.uptimeSec).toBe('number');

    const stringified = JSON.stringify(json);
    expect(stringified).not.toContain('secret');
    expect(stringified).not.toContain('password');
    expect(stringified).not.toContain(secret);
  });

  it('capture mode writes a file and does not call router', async () => {
    let routerCalled = false;
    const captureDir = path.resolve(__dirname, '../.capture-test');
    if (fs.existsSync(captureDir)) {
      fs.rmSync(captureDir, { recursive: true, force: true });
    }

    const captureConfig: BotConfig = {
      ...config,
      CAPTURE_MODE: true,
    };

    const gateway = new OpenWAGatewayAdapter(captureConfig);
    const accessController = new AccessController(config.ALLOWED_SENDERS);
    const server = buildServer({
      config: captureConfig,
      gateway,
      accessController,
      dedupeLru: accessController.dedupeLru,
      onMessage: async () => {
        routerCalled = true;
      },
      checkDb: async () => true,
    });

    const raw = Buffer.from(JSON.stringify({ hello: 'capture' }));
    const res = await server.inject({
      method: 'POST',
      url: `/webhook/${token}`,
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-openwa-signature': 'sha256=abcdef',
        'x-custom-api-key': 'secret-12345',
      },
    });

    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(routerCalled).toBe(false);
  });
});
