import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import {
  NLSQLClient,
  CsvExportService,
  loadExportConfigFromEnv,
  startCleanupTimer,
  type NLSQLClientConfig,
  type ExportConfig,
  type FewShotExample,
} from 'nlsql';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { createGateway } from './gateway';
import { AccessController } from './access';
import { ChatStateStore, RateLimiter, Semaphore } from './state';
import { MessageRouter } from './router';
import { buildServer } from './server';

async function bootstrap() {
  // 1. Config
  const config = loadConfig();

  // 2. Logger
  const logger = createLogger(config.LOG_LEVEL);

  // 3. NLSQLClient
  const clientConfig: NLSQLClientConfig = {
    db: {
      host: config.DB_HOST,
      port: config.DB_PORT,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      database: config.DB_NAME,
      ssl: config.DB_SSL
        ? config.DB_SSL_CA
          ? { ca: fs.readFileSync(config.DB_SSL_CA) }
          : true
        : undefined,
    },
    llm: {
      provider: 'gemini',
      apiKey: config.GEMINI_API_KEY,
      model: config.GEMINI_MODEL,
    },
    storage: {
      type: 'file',
      path: config.ENRICHMENT_PATH,
    },
  };

  const client = new NLSQLClient(clientConfig);

  // 4. Initialise client / schema enrichment
  try {
    const summary = await client.initialise({ forceRefresh: false });
    if (summary) {
      logger.info(
        {
          totalTables: summary.totalTables,
          enrichedCount: summary.enriched,
          skippedCount: summary.skipped,
          failedCount: summary.failed.length,
        },
        'NLSQLClient initialised and schema enriched'
      );
    } else {
      logger.info('NLSQLClient initialised (no enrichment performed)');
    }
  } catch (err: any) {
    logger.fatal(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to initialise NLSQLClient during startup'
    );
    process.exit(1);
  }

  // 5. Export service + cleanup timer
  let exportService: CsvExportService | null = null;
  let exportConfig: ExportConfig | null = null;
  let cleanupTimer: { stop(): void } | null = null;

  if (config.EXPORT_BASE_URL) {
    try {
      exportConfig = loadExportConfigFromEnv(process.env);
      exportService = new CsvExportService(client, exportConfig);
      cleanupTimer = startCleanupTimer(exportConfig);
      logger.info('CSV export service and cleanup timer initialised');
    } catch (err: any) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to initialise CSV export service; exports will be disabled'
      );
    }
  }

  // 6. Few-shot examples
  const fewShotExamples: FewShotExample[] = [];
  const examplesPath = path.resolve(
    process.cwd().endsWith('bot')
      ? path.resolve(process.cwd(), 'config/examples.json')
      : path.resolve(process.cwd(), 'bot/config/examples.json')
  );

  if (fs.existsSync(examplesPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(examplesPath, 'utf8'));
      const exampleSchema = z.array(
        z.object({ question: z.string(), sql: z.string() })
      );
      const parsed = exampleSchema.parse(raw);
      for (const ex of parsed) {
        const val = client.validateSQL(ex.sql);
        if (val.isValid) {
          fewShotExamples.push(ex);
        } else {
          logger.warn(
            { question: ex.question, reason: val.reason },
            'Dropped invalid few-shot example'
          );
        }
      }
      logger.info(
        { count: fewShotExamples.length },
        'Loaded few-shot examples'
      );
    } catch (err: any) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to parse few-shot examples file'
      );
    }
  }

  // 7. Gateway adapter & Router
  const gateway = createGateway(config);
  const accessController = new AccessController(
    config.ALLOWED_SENDERS,
    config.MAX_MESSAGE_AGE_SEC
  );
  const stateStore = new ChatStateStore();
  const rateLimiter = new RateLimiter(
    config.RATE_LIMIT_PER_MIN,
    config.DAILY_QUERY_LIMIT
  );
  const semaphore = new Semaphore(2);

  const router = new MessageRouter({
    config,
    client,
    gateway,
    accessController,
    stateStore,
    rateLimiter,
    semaphore,
    exportService,
    exportConfig,
    fewShotExamples,
    logger,
  });

  // 8. Server
  const server = buildServer({
    config,
    gateway,
    accessController,
    dedupeLru: accessController.dedupeLru,
    onMessage: (msg) => router.handleInbound(msg),
    checkDb: async () => {
      try {
        const res = await (client as any).adapter?.query('SELECT 1');
        return Boolean(res);
      } catch {
        return false;
      }
    },
    logger,
  });

  // 9. Listen
  try {
    await server.listen({ port: config.PORT, host: config.HOST });
    logger.info(
      {
        port: config.PORT,
        host: config.HOST,
        flavor: config.OPENWA_FLAVOR,
      },
      'nlsql-bot is ready and listening'
    );
  } catch (err: any) {
    logger.fatal(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to bind server port'
    );
    process.exit(1);
  }

  // 10. Graceful shutdown
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown initiated');

    try {
      await server.close();
      if (cleanupTimer) cleanupTimer.stop();
      // Wait up to 10s for active tasks
      await new Promise((r) => setTimeout(r, 1000));
      await client.close();
      logger.info('Shutdown complete');
    } catch (err: any) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Error during shutdown'
      );
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error('Fatal bootstrap error:', err);
    process.exit(1);
  });
}
