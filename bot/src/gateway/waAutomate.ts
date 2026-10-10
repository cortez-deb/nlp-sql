import { splitTextIntoChunks } from './openwa';
import { GatewayAdapter, GatewayError, ParseResult } from './types';
import type { BotConfig } from '../config';

const CHUNK_SIZE = 3800;

export class WAAutomateGatewayAdapter implements GatewayAdapter {
  constructor(private readonly config: BotConfig) {}

  parse(
    rawBody: Buffer,
    _headers: Record<string, string | string[] | undefined>
  ): ParseResult {
    try {
      let payload: any;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return { kind: 'reject', status: 400 };
      }

      if (!payload || typeof payload !== 'object') {
        return { kind: 'reject', status: 400 };
      }

      // If wrapped format with event
      if (payload.event !== undefined && payload.event !== 'onMessage') {
        return { kind: 'ignore' };
      }

      const data = payload.data ? payload.data : payload;
      if (!data || typeof data !== 'object') {
        return { kind: 'ignore' };
      }

      // Check message type ('chat' or absent)
      if (data.type !== undefined && data.type !== 'chat') {
        return { kind: 'ignore' };
      }

      if (typeof data.body !== 'string' || !data.body.trim()) {
        return { kind: 'ignore' };
      }

      let id = '';
      if (typeof data.id === 'string') {
        id = data.id;
      } else if (data.id && typeof data.id === 'object' && data.id._serialized) {
        id = String(data.id._serialized);
      } else {
        id = String(data.id ?? '');
      }

      const text = data.body;
      const chatId = String(data.chatId ?? data.from ?? '');
      const senderId = String(
        data.sender?.id ?? data.author ?? data.from ?? ''
      );

      const isGroup =
        data.isGroupMsg === true || chatId.endsWith('@g.us');
      const fromMe = data.fromMe === true;

      let timestampMs = Date.now();
      const rawTs = data.t ?? data.timestamp;
      if (rawTs !== undefined && rawTs !== null) {
        const num = Number(rawTs);
        if (!Number.isNaN(num) && num > 0) {
          timestampMs = num >= 1e12 ? num : num * 1000;
        }
      }

      const dedupeKey = id;

      return {
        kind: 'message',
        msg: {
          id,
          dedupeKey,
          chatId,
          senderId,
          text,
          isGroup,
          fromMe,
          type: data.type ?? 'chat',
          timestampMs,
        },
      };
    } catch {
      return { kind: 'reject', status: 400 };
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const chunks = splitTextIntoChunks(text, CHUNK_SIZE);
    for (const chunk of chunks) {
      await this.sendSingleChunk(chatId, chunk);
    }
  }

  private async sendSingleChunk(chatId: string, text: string): Promise<void> {
    const url = `${this.config.OPENWA_BASE_URL}${this.config.sendTextPath}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [this.config.apiKeyHeader]: this.config.OPENWA_API_KEY,
    };

    const body = JSON.stringify({
      args: {
        to: chatId,
        content: text,
      },
    });

    const max5xxRetries = 2;
    const backoff5xx = [500, 1500];
    let attempt5xx = 0;

    while (true) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(15000),
        });

        const textBody = await res.text().catch(() => '');
        const truncated = textBody.slice(0, 200);

        if (res.ok) {
          try {
            const parsed = JSON.parse(textBody);
            if (parsed && parsed.success === false) {
              throw new GatewayError(
                res.status,
                `Gateway returned success: false: ${truncated}`
              );
            }
          } catch (e) {
            if (e instanceof GatewayError) throw e;
            // Non-JSON or standard 2xx ok
          }
          return;
        }

        const status = res.status;
        if (status >= 500) {
          if (attempt5xx < max5xxRetries) {
            const delay = backoff5xx[attempt5xx];
            attempt5xx++;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw new GatewayError(
            status,
            `Gateway server error ${status}: ${truncated}`
          );
        }

        // 4xx errors
        throw new GatewayError(
          status,
          `Gateway client error ${status}: ${truncated}`
        );
      } catch (err: any) {
        if (err instanceof GatewayError) {
          throw err;
        }

        if (attempt5xx < max5xxRetries) {
          const delay = backoff5xx[attempt5xx];
          attempt5xx++;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        const msg = err instanceof Error ? err.message : String(err);
        const sanitizedMsg = msg.replace(
          this.config.OPENWA_API_KEY,
          '[REDACTED]'
        );
        throw new GatewayError(0, `Gateway network error: ${sanitizedMsg}`);
      }
    }
  }
}
