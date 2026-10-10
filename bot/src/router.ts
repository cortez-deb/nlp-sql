import {
  detectExportIntent,
  type NLSQLClient,
  type CsvExportService,
  type ExportConfig,
  type FewShotExample,
} from 'nlsql';
import type { BotConfig } from './config';
import type { GatewayAdapter, InboundMessage } from './gateway';
import { AccessController, maskSenderId } from './access';
import { ChatState, ChatStateStore, RateLimiter, Semaphore } from './state';
import { formatAnswer, friendlyError } from './format';
import { handleCommand } from './commands';

export interface RouterDependencies {
  config: BotConfig;
  client: NLSQLClient;
  gateway: GatewayAdapter;
  accessController: AccessController;
  stateStore: ChatStateStore;
  rateLimiter: RateLimiter;
  semaphore: Semaphore;
  exportService?: CsvExportService | null;
  exportConfig?: ExportConfig | null;
  fewShotExamples?: FewShotExample[];
  logger?: any;
  now?: () => number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class MessageRouter {
  private config: BotConfig;
  private client: NLSQLClient;
  private gateway: GatewayAdapter;
  private accessController: AccessController;
  private stateStore: ChatStateStore;
  private rateLimiter: RateLimiter;
  private semaphore: Semaphore;
  private exportService?: CsvExportService | null;
  private exportConfig?: ExportConfig | null;
  private fewShotExamples: FewShotExample[];
  private logger?: any;
  private getNow: () => number;

  constructor(deps: RouterDependencies) {
    this.config = deps.config;
    this.client = deps.client;
    this.gateway = deps.gateway;
    this.accessController = deps.accessController;
    this.stateStore = deps.stateStore;
    this.rateLimiter = deps.rateLimiter;
    this.semaphore = deps.semaphore;
    this.exportService = deps.exportService;
    this.exportConfig = deps.exportConfig;
    this.fewShotExamples = deps.fewShotExamples ?? [];
    this.logger = deps.logger;
    this.getNow = deps.now ?? (() => Date.now());
  }

  async handleInbound(msg: InboundMessage): Promise<void> {
    const now = this.getNow();
    const decision = this.accessController.check(msg, now);

    if (!decision.allowed) {
      if (decision.reason === 'unknown_sender') {
        const sender = msg.senderPhone
          ? `${msg.senderPhone}@c.us`
          : msg.senderId || msg.chatId;

        if (!this.accessController.isWarned(sender)) {
          this.accessController.markWarned(sender);
          if (this.config.LOG_LEVEL === 'debug') {
            this.logger?.warn(
              { senderId: sender },
              `ignored unknown sender ${sender}`
            );
          } else {
            this.logger?.warn(
              { senderId: maskSenderId(sender) },
              `ignored unknown sender ${maskSenderId(sender)}`
            );
          }
        }
        return;
      }

      if (decision.reply) {
        try {
          await this.gateway.sendText(msg.chatId, decision.reply);
        } catch {
          // Swallow sendText errors
        }
      }

      return;
    }

    const ownerId = decision.ownerId;
    const state = this.stateStore.get(msg.chatId);

    // Per-chat sequential queuing
    const prevQueue = state.queue;
    state.queue = (async () => {
      try {
        await prevQueue;
      } catch {
        // Prev task failure should not break queue
      }
      await this.processMessage(msg, ownerId, state);
    })();

    await state.queue;
  }

  private async processMessage(
    msg: InboundMessage,
    ownerId: string,
    state: ChatState
  ): Promise<void> {
    const release = await this.semaphore.acquire();
    try {
      const text = msg.text.trim();

      if (text.startsWith('/')) {
        await handleCommand({
          chatId: msg.chatId,
          ownerId,
          commandText: text,
          state,
          client: this.client,
          gateway: this.gateway,
          onExportLast: () =>
            this.handleExport({ kind: 'last' }, msg.chatId, ownerId, state),
        });
        return;
      }

      const intent = detectExportIntent(text);
      if (intent) {
        await this.handleExport(intent, msg.chatId, ownerId, state);
        return;
      }

      await this.handleQuestion(text, msg, ownerId, state);
    } catch (err: any) {
      this.logger?.error(
        {
          msgId: msg.id,
          ownerId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Unexpected error processing inbound message'
      );
      try {
        await this.gateway.sendText(
          msg.chatId,
          'Something went wrong. Please try again.'
        );
      } catch {
        // Swallow sendText failure
      }
    } finally {
      release();
    }
  }

  private async handleQuestion(
    text: string,
    msg: InboundMessage,
    ownerId: string,
    state: ChatState
  ): Promise<void> {
    const now = this.getNow();
    const rl = this.rateLimiter.check(msg.chatId, now);

    if (!rl.allowed) {
      const replyText =
        rl.reason === 'daily'
          ? 'Daily limit reached.'
          : 'Slow down a little, try again in a minute.';
      await this.gateway.sendText(msg.chatId, replyText);
      return;
    }

    this.rateLimiter.record(msg.chatId, now);

    if (this.gateway.sendTyping) {
      this.gateway.sendTyping(msg.chatId, 'typing').catch(() => {});
    }

    let ackTimer: NodeJS.Timeout | null = null;

    ackTimer = setTimeout(async () => {
      try {
        await this.gateway.sendText(msg.chatId, 'Working on it...');
      } catch {
        // Ignore ack send failures
      }
    }, 4000);

    try {
      const currentDate = new Date(now).toLocaleDateString('en-CA');
      const result = await this.client.query(text, {
        history: [...state.turns],
        summarize: true,
        summaryMaxChars: 600,
        maxRetries: 2,
        fewShotExamples: this.fewShotExamples,
        currentDate,
      });

      if (ackTimer) clearTimeout(ackTimer);

      if (result.error) {
        const errReply = friendlyError(result);
        await this.gateway.sendText(msg.chatId, errReply);

        this.logger?.info(
          {
            msgId: msg.id,
            ownerId,
            attempts: result.attempts,
            errorKind: result.errorKind,
            timing: result.timing,
          },
          'Query error'
        );
      } else {
        const formatted = formatAnswer(result, {
          locale: this.config.LOCALE,
          exportEnabled: Boolean(this.exportService),
        });
        await this.gateway.sendText(msg.chatId, formatted);

        const resultColumns =
          result.results && result.results.length > 0
            ? Object.keys(result.results[0])
            : [];

        state.turns.push({
          question: text,
          sql: result.sql!,
          resultColumns,
          rowCount: result.rowCount,
          summary: result.summary ?? '',
        });

        if (state.turns.length > 3) {
          state.turns = state.turns.slice(-3);
        }

        state.lastQuery = {
          question: text,
          sql: result.sql!,
        };

        this.logger?.info(
          {
            msgId: msg.id,
            ownerId,
            attempts: result.attempts,
            rowCount: result.rowCount,
            timing: result.timing,
          },
          'Query success'
        );
      }
    } finally {
      if (ackTimer) clearTimeout(ackTimer);
      if (this.gateway.sendTyping) {
        this.gateway.sendTyping(msg.chatId, 'paused').catch(() => {});
      }
    }
  }

  private async handleExport(
    intent: { kind: 'last' } | { kind: 'new'; question: string },
    chatId: string,
    ownerId: string,
    state: ChatState
  ): Promise<void> {
    const now = this.getNow();
    const rl = this.rateLimiter.check(chatId, now);

    if (!rl.allowed) {
      const replyText =
        rl.reason === 'daily'
          ? 'Daily limit reached.'
          : 'Slow down a little, try again in a minute.';
      await this.gateway.sendText(chatId, replyText);
      return;
    }

    this.rateLimiter.record(chatId, now);

    if (!this.exportService) {
      await this.gateway.sendText(chatId, "CSV export isn't set up yet.");
      return;
    }

    let sqlToExport = '';
    let questionText = '';

    if (intent.kind === 'last') {
      if (!state.lastQuery || !state.lastQuery.sql) {
        await this.gateway.sendText(
          chatId,
          'Ask a question first, then reply `csv`.'
        );
        return;
      }
      sqlToExport = state.lastQuery.sql;
      questionText = state.lastQuery.question;
    } else {
      // intent.kind === 'new'
      const currentDate = new Date(now).toLocaleDateString('en-CA');
      const result = await this.client.query(intent.question, {
        history: [...state.turns],
        summarize: false,
        maxRetries: 2,
        fewShotExamples: this.fewShotExamples,
        currentDate,
      });

      if (result.error || !result.sql) {
        await this.gateway.sendText(chatId, friendlyError(result));
        return;
      }

      sqlToExport = result.sql;
      questionText = intent.question;
      state.lastQuery = {
        question: questionText,
        sql: sqlToExport,
      };

      // If small table, reply with short answer first
      if (result.rowCount <= 5 && result.results && result.results.length > 0) {
        const formatted = formatAnswer(result, {
          locale: this.config.LOCALE,
          exportEnabled: true,
        });
        await this.gateway.sendText(chatId, formatted);
      }
    }

    // Ack timer after 4s
    let ackTimer: NodeJS.Timeout | null = null;
    ackTimer = setTimeout(async () => {
      try {
        await this.gateway.sendText(chatId, 'Preparing your export...');
      } catch {
        // Ignore ack failure
      }
    }, 4000);

    try {
      const exportRes = await this.exportService.export({
        ownerId,
        sql: sqlToExport,
        question: questionText,
      });

      if (ackTimer) clearTimeout(ackTimer);

      if (!exportRes.ok) {
        let msg = 'Export failed. Please try again.';
        if (exportRes.code === 'EMPTY') {
          msg = 'No rows to export.';
        } else if (exportRes.code === 'REJECTED') {
          msg = "I can't export that query.";
        } else if (exportRes.code === 'TIMEOUT') {
          msg = 'The export took too long. Try a narrower question.';
        }
        await this.gateway.sendText(chatId, msg);
        return;
      }

      const ttlHours = this.exportConfig?.ttlHours ?? 24;
      const sizeStr = formatBytes(exportRes.bytes);
      let replyMsg = `Export ready: ${exportRes.rowCount} rows, ${exportRes.columns.length} columns, ${sizeStr}.\n${exportRes.url}\nLink valid for ${ttlHours}h.`;

      if (exportRes.truncatedReason === 'rows') {
        replyMsg += `\nLimited to the first ${this.exportConfig?.maxRows ?? 100000} rows.`;
      } else if (exportRes.truncatedReason === 'bytes') {
        const maxMb = Math.round(
          (this.exportConfig?.maxBytes ?? 50 * 1024 * 1024) / (1024 * 1024)
        );
        replyMsg += `\nLimited to ${maxMb} MB.`;
      }

      await this.gateway.sendText(chatId, replyMsg);
    } catch (err: any) {
      this.logger?.error(
        {
          ownerId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Export execution failed'
      );
      await this.gateway.sendText(chatId, 'Export failed. Please try again.');
    } finally {
      if (ackTimer) clearTimeout(ackTimer);
    }
  }
}
