import { MessageRouter } from '../src/router';
import { AccessController } from '../src/access';
import { ChatStateStore, RateLimiter, Semaphore } from '../src/state';
import type { GatewayAdapter, InboundMessage } from '../src/gateway';
import type {
  NLSQLClient,
  QueryResult,
  QueryOptions,
  EnrichedTable,
  CsvExportService,
  ExportRequest,
  ExportResult,
} from 'nlsql';
import type { BotConfig } from '../src/config';

class FakeGateway implements GatewayAdapter {
  public sentMessages: { chatId: string; text: string }[] = [];
  public typingEvents: { chatId: string; state: string }[] = [];
  public shouldFailSend = false;

  parse(): any {
    return { kind: 'ignore' };
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (this.shouldFailSend) {
      throw new Error('Fake network failure sending text');
    }
    this.sentMessages.push({ chatId, text });
  }

  async sendTyping(chatId: string, state: 'typing' | 'paused'): Promise<void> {
    this.typingEvents.push({ chatId, state });
  }
}

class FakeNLSQLClient {
  public queries: { question: string; options: QueryOptions }[] = [];
  public mockResult: QueryResult = {
    sql: 'SELECT * FROM products',
    results: [{ id: 1, name: 'Sample' }],
    error: null,
    attempts: 1,
    truncated: false,
    rowCount: 1,
    summary: 'Here is 1 product.',
    timing: { retrievalMs: 1, generationMs: 10, validationMs: 1, executionMs: 2, totalMs: 14 },
  };
  public enrichDelayMs = 0;
  public enrichCallCount = 0;

  async query(question: string, options: QueryOptions): Promise<QueryResult> {
    this.queries.push({ question, options });
    return this.mockResult;
  }

  async getEnrichedSchema(): Promise<EnrichedTable[]> {
    return [
      {
        tableName: 'products',
        businessName: 'Store Products',
        description: 'Products catalog',
        columns: [],
      } as unknown as EnrichedTable,
    ];
  }

  async enrich(_opts?: any): Promise<any> {
    this.enrichCallCount++;
    if (this.enrichDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.enrichDelayMs));
    }
    return {
      totalTables: 5,
      enriched: 2,
      skipped: 3,
      failed: [],
      durationMs: 100,
    };
  }
}

class FakeExportService {
  public exports: ExportRequest[] = [];
  public mockResult: ExportResult = {
    ok: true,
    url: 'https://files.example.com/downloads/david/export.csv',
    fileName: 'export',
    relativePath: 'david/export.csv',
    rowCount: 100,
    columns: ['id', 'name'],
    truncated: false,
    bytes: 2048,
    expiresAt: '2026-10-11T12:00:00Z',
  };

  async export(req: ExportRequest): Promise<ExportResult> {
    this.exports.push(req);
    return this.mockResult;
  }
}

describe('MessageRouter', () => {
  let config: BotConfig;
  let gateway: FakeGateway;
  let client: FakeNLSQLClient;
  let exportService: FakeExportService;
  let accessController: AccessController;
  let stateStore: ChatStateStore;
  let rateLimiter: RateLimiter;
  let semaphore: Semaphore;
  let router: MessageRouter;
  let mockTime = 1760000000000;

  beforeEach(() => {
    config = {
      PORT: 3000,
      HOST: '127.0.0.1',
      OPENWA_FLAVOR: 'openwa-gateway',
      WEBHOOK_PATH_TOKEN: '123456789012345678901234',
      WEBHOOK_HMAC_SECRET: 'secret-key-16-bytes',
      OPENWA_SESSION_ID: 'sess-1',
      OPENWA_BASE_URL: 'http://localhost:2785',
      OPENWA_API_KEY: 'test-api-key',
      apiKeyHeader: 'X-API-Key',
      sendTextPath: '/api/sessions/{sessionId}/messages/send-text',
      ALLOWED_SENDERS: 'david:254712345678@c.us,alice:254700000000@c.us',
      DB_HOST: 'localhost',
      DB_PORT: 3306,
      DB_USER: 'root',
      DB_PASSWORD: '',
      DB_NAME: 'shop',
      DB_SSL: false,
      GEMINI_API_KEY: 'key',
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
      INTENT_ROUTING_ENABLED: true,
      MEMORY_ENABLED: false,
    };

    gateway = new FakeGateway();
    client = new FakeNLSQLClient();
    exportService = new FakeExportService();
    accessController = new AccessController(config.ALLOWED_SENDERS);
    stateStore = new ChatStateStore();
    rateLimiter = new RateLimiter(config.RATE_LIMIT_PER_MIN, config.DAILY_QUERY_LIMIT);
    semaphore = new Semaphore(2);
    mockTime = 1760000000000;

    router = new MessageRouter({
      config,
      client: client as unknown as NLSQLClient,
      gateway,
      accessController,
      stateStore,
      rateLimiter,
      semaphore,
      exportService: exportService as unknown as CsvExportService,
      memoryStore: new (require('../src/memory').NoopMemoryStore)(),
        memoryService: { extractAndStore: jest.fn(), buildMemoryContextText: jest.fn().mockResolvedValue('') },
      exportConfig: {
        rootDir: '/var/www/downloads',
        baseUrl: 'https://files.example.com/downloads',
        ttlHours: 24,
        maxRows: 100000,
      },
      now: () => mockTime,
    });
  });

  const createMsg = (text: string, id = 'm1'): InboundMessage => ({
    id,
    dedupeKey: `key_${id}`,
    chatId: '254712345678@c.us',
    senderId: '254712345678@c.us',
    text,
    isGroup: false,
    fromMe: false,
    type: 'text',
    timestampMs: mockTime,
  });

  it('answers a natural language question and stores conversation turn', async () => {
    await router.handleInbound(createMsg('How many products?'));

    expect(gateway.sentMessages.length).toBe(1);
    expect(gateway.sentMessages[0].text).toBe('Here is 1 product.');

    const state = stateStore.get('254712345678@c.us');
    expect(state.turns.length).toBe(1);
    expect(state.turns[0].question).toBe('How many products?');
    expect(state.turns[0].sql).toBe('SELECT * FROM products');
    expect(state.lastQuery?.sql).toBe('SELECT * FROM products');
  });

  it('passes conversation history in follow-up queries', async () => {
    await router.handleInbound(createMsg('First question', 'm1'));
    await router.handleInbound(createMsg('Now only gold tier', 'm2'));

    expect(client.queries.length).toBe(2);
    expect(client.queries[1].options.history?.length).toBe(1);
    expect(client.queries[1].options.history![0].question).toBe('First question');
  });

  it('caps history at max 3 turns', async () => {
    for (let i = 1; i <= 5; i++) {
      await router.handleInbound(createMsg(`Question ${i}`, `m${i}`));
    }

    const state = stateStore.get('254712345678@c.us');
    expect(state.turns.length).toBe(3);
    expect(state.turns[0].question).toBe('Question 3');
    expect(state.turns[2].question).toBe('Question 5');
  });

  it('does not store turns when query fails with an error', async () => {
    client.mockResult = {
      sql: null,
      results: null,
      error: 'LLM failed',
      errorKind: 'llm',
      attempts: 2,
      truncated: false,
      rowCount: 0,
      timing: { retrievalMs: 1, generationMs: 10, validationMs: 0, executionMs: 0, totalMs: 11 },
    };

    await router.handleInbound(createMsg('Faulty question'));

    expect(gateway.sentMessages.length).toBe(1);
    expect(gateway.sentMessages[0].text).toContain('AI service is unavailable');

    const state = stateStore.get('254712345678@c.us');
    expect(state.turns.length).toBe(0);
    expect(state.lastQuery).toBeNull();
  });

  it('handles /help command', async () => {
    await router.handleInbound(createMsg('/help'));
    expect(gateway.sentMessages[0].text).toContain('Database Assistant Help');
  });

  it('handles /tables command', async () => {
    await router.handleInbound(createMsg('/tables'));
    expect(gateway.sentMessages[0].text).toContain('Store Products (products)');
  });

  it('handles /sql command before and after queries', async () => {
    await router.handleInbound(createMsg('/sql', 'm1'));
    expect(gateway.sentMessages[0].text).toBe('No query yet.');

    await router.handleInbound(createMsg('Show products', 'm2'));
    await router.handleInbound(createMsg('/sql', 'm3'));

    expect(gateway.sentMessages[2].text).toContain('SELECT * FROM products');
  });

  it('handles /reset command', async () => {
    await router.handleInbound(createMsg('First question', 'm1'));
    expect(stateStore.get('254712345678@c.us').turns.length).toBe(1);

    await router.handleInbound(createMsg('/reset', 'm2'));
    expect(gateway.sentMessages[1].text).toBe('Conversation context reset.');
    expect(stateStore.get('254712345678@c.us').turns.length).toBe(0);
    expect(stateStore.get('254712345678@c.us').lastQuery).toBeNull();
  });

  it('handles /refresh single-flight', async () => {
    client.enrichDelayMs = 50;

    const p1 = router.handleInbound(createMsg('/refresh', 'm1'));
    const p2 = router.handleInbound({
      ...createMsg('/refresh', 'm2'),
      chatId: '254700000000@c.us',
      senderId: '254700000000@c.us',
    });

    await Promise.all([p1, p2]);

    expect(
      gateway.sentMessages.some((m) => m.text.includes('already running'))
    ).toBe(true);
  });

  it('handles csv intent with and without lastQuery', async () => {
    // Without last query
    await router.handleInbound(createMsg('csv', 'm1'));
    expect(gateway.sentMessages[0].text).toBe('Ask a question first, then reply `csv`.');

    // Run question first
    await router.handleInbound(createMsg('Show products', 'm2'));

    // Now reply csv
    await router.handleInbound(createMsg('csv', 'm3'));
    expect(exportService.exports.length).toBe(1);
    expect(exportService.exports[0].ownerId).toBe('david');
    expect(gateway.sentMessages[2].text).toContain('Export ready: 100 rows');
  });

  it('handles "export x as csv" as new query and export', async () => {
    await router.handleInbound(createMsg('export all products as csv'));

    expect(client.queries.length).toBe(1);
    expect(client.queries[0].question).toBe('all products');
    expect(exportService.exports.length).toBe(1);
    expect(
      gateway.sentMessages.some((m) => m.text.includes('Export ready: 100 rows'))
    ).toBe(true);
  });

  it('enforces rate limits per minute and daily limit', async () => {
    // Consume rate limit (10 per min)
    for (let i = 1; i <= 10; i++) {
      await router.handleInbound(createMsg(`Query ${i}`, `m${i}`));
    }

    // 11th request in same minute should be rejected
    await router.handleInbound(createMsg('Query 11', 'm11'));
    expect(gateway.sentMessages[10].text).toBe('Slow down a little, try again in a minute.');

    // Fast-forward past 1 minute
    mockTime += 61000;
    await router.handleInbound(createMsg('Query 12', 'm12'));
    expect(gateway.sentMessages[11].text).not.toContain('Slow down');
  });

  it('ensures per-chat sequential ordering', async () => {
    const executionOrder: string[] = [];
    const origQuery = client.query.bind(client);

    client.query = async (q: string, opts: any) => {
      if (q === 'first') {
        await new Promise((r) => setTimeout(r, 50));
      }
      executionOrder.push(q);
      return origQuery(q, opts);
    };

    const p1 = router.handleInbound(createMsg('first', 'm1'));
    const p2 = router.handleInbound(createMsg('second', 'm2'));

    await Promise.all([p1, p2]);
    expect(executionOrder).toEqual(['first', 'second']);
  });

  it('handles memory write intent', async () => {
    const intentClassifier = {
      classify: async () => 'memory_write',
      generateChitchatReply: async () => '',
    };
    
    // Inject mock classifier
    (router as any).intentClassifier = intentClassifier;
    
    await router.handleInbound(createMsg('My name is David'));
    expect(gateway.sentMessages[0].text).toBe('I have noted that down.');
  });

  it('handles memory read intent', async () => {
    const intentClassifier = {
      classify: async () => 'memory_read',
      generateChitchatReply: async () => '',
    };
    
    (router as any).intentClassifier = intentClassifier;

    await router.handleInbound(createMsg('What is my name?'));
    expect(gateway.sentMessages[0].text).toBe('I don\'t remember anything specific yet.');
  });

  it('handles chitchat intent', async () => {
    const intentClassifier = {
      classify: async () => 'chitchat',
      generateChitchatReply: async () => 'Hello! How can I help you today?',
    };
    
    (router as any).intentClassifier = intentClassifier;

    await router.handleInbound(createMsg('Hello'));
    expect(gateway.sentMessages[0].text).toBe('Hello! How can I help you today?');
  });

  it('falls back to database question if intent classifier fails', async () => {
    const intentClassifier = {
      classify: async () => { throw new Error('Classifier failed'); },
      generateChitchatReply: async () => '',
    };
    
    (router as any).intentClassifier = intentClassifier;

    await router.handleInbound(createMsg('What are the products?'));
    
    expect(gateway.sentMessages[0].text).toBe('Here is 1 product.');
  });
});
