import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import fastify, { FastifyInstance } from 'fastify';
import type { BotConfig } from './config';
import type { GatewayAdapter, InboundMessage } from './gateway';
import type { AccessController, SimpleLru } from './access';

export interface ServerOptions {
  config: BotConfig;
  gateway: GatewayAdapter;
  accessController: AccessController;
  dedupeLru: SimpleLru<string, boolean>;
  onMessage: (msg: InboundMessage) => Promise<void>;
  checkDb: () => Promise<boolean>;
  logger?: any;
}

export function timingSafeTokenMatch(given: string, expected: string): boolean {
  if (!given || !expected) return false;
  const h1 = crypto.createHash('sha256').update(given).digest();
  const h2 = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(h1, h2);
}

export function saveCapture(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  baseDir?: string
): void {
  try {
    const captureDir =
      baseDir ||
      path.resolve(
        process.cwd().endsWith('bot')
          ? path.resolve(process.cwd(), '.capture')
          : path.resolve(process.cwd(), 'bot/.capture')
      );

    if (!fs.existsSync(captureDir)) {
      fs.mkdirSync(captureDir, { recursive: true });
    }

    // Mask sensitive headers
    const maskedHeaders: Record<string, any> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      if (lower === 'x-openwa-signature' || lower === 'authorization' || lower.includes('key')) {
        maskedHeaders[k] = '[REDACTED]';
      } else {
        maskedHeaders[k] = v;
      }
    }

    let parsedBody: any;
    try {
      parsedBody = JSON.parse(rawBody.toString('utf8'));
    } catch {
      parsedBody = rawBody.toString('utf8');
    }

    const captureData = {
      timestamp: new Date().toISOString(),
      headers: maskedHeaders,
      body: parsedBody,
    };

    const filePath = path.join(captureDir, `${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`);
    fs.writeFileSync(filePath, JSON.stringify(captureData, null, 2), 'utf8');

    // Rotate oldest files if > 200
    const files = fs
      .readdirSync(captureDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({
        name: f,
        time: fs.statSync(path.join(captureDir, f)).mtimeMs,
      }))
      .sort((a, b) => a.time - b.time);

    if (files.length > 200) {
      const toDelete = files.slice(0, files.length - 200);
      for (const f of toDelete) {
        fs.unlinkSync(path.join(captureDir, f.name));
      }
    }
  } catch (err) {
    // Never crash on capture failure
  }
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { config, gateway, dedupeLru, onMessage, checkDb } = options;

  const app = fastify({
    bodyLimit: 1024 * 1024, // 1 MB limit
    disableRequestLogging: true,
  });

  // Raw buffer parser for HMAC verification
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    }
  );

  // Cached DB health state (30s)
  let cachedDbStatus = false;
  let lastDbCheck = 0;
  const startTime = Date.now();

  app.get('/healthz', async (_req, reply) => {
    const now = Date.now();
    if (now - lastDbCheck > 30000) {
      try {
        cachedDbStatus = await checkDb();
      } catch {
        cachedDbStatus = false;
      }
      lastDbCheck = now;
    }

    return reply.status(200).send({
      ok: true,
      db: cachedDbStatus,
      uptimeSec: Math.floor((now - startTime) / 1000),
    });
  });

  app.post<{ Params: { token: string } }>(
    '/webhook/:token',
    async (req, reply) => {
      const token = req.params.token;
      if (!timingSafeTokenMatch(token, config.WEBHOOK_PATH_TOKEN)) {
        return reply.status(404).send('');
      }

      const rawBody = req.body as Buffer;
      if (!rawBody || !Buffer.isBuffer(rawBody)) {
        return reply.status(400).send({ error: 'Missing or malformed body' });
      }

      // Capture mode
      if (config.CAPTURE_MODE) {
        saveCapture(rawBody, req.headers as Record<string, string | string[] | undefined>);
        if (options.logger) {
          options.logger.info({ action: 'captured' }, 'Webhook payload captured');
        }
        return reply.status(200).send({ ok: true });
      }

      // Gateway parsing
      const parseResult = gateway.parse(
        rawBody,
        req.headers as Record<string, string | string[] | undefined>
      );

      if (parseResult.kind === 'reject') {
        return reply.status(parseResult.status).send({
          error: parseResult.status === 401 ? 'Unauthorized' : 'Bad Request',
        });
      }

      if (parseResult.kind === 'ignore') {
        return reply.status(200).send({ ok: true });
      }

      const msg = parseResult.msg;

      // Dedupe check
      if (dedupeLru.has(msg.dedupeKey)) {
        return reply.status(200).send({ ok: true });
      }
      dedupeLru.set(msg.dedupeKey, true);

      // Send 200 immediately (< 100ms)
      reply.status(200).send({ ok: true });

      // Asynchronous dispatch
      setImmediate(async () => {
        try {
          await onMessage(msg);
        } catch (err: any) {
          if (options.logger) {
            options.logger.error(
              {
                msgId: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              'Unhandled error processing message'
            );
          }
        }
      });
    }
  );

  // Catch-all 404 with empty body
  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send('');
  });

  return app;
}
