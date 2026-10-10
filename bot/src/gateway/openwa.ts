import { verifySignature } from './signature';
import { GatewayAdapter, GatewayError, ParseResult } from './types';
import type { BotConfig } from '../config';

const CHUNK_SIZE = 3800;

export function splitTextIntoChunks(text: string, maxLen = CHUNK_SIZE): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = -1;
    // Try to split on double newline
    const dblNewline = remaining.lastIndexOf('\n\n', maxLen);
    if (dblNewline > 0) {
      splitIndex = dblNewline + 2;
    } else {
      // Try single newline
      const sglNewline = remaining.lastIndexOf('\n', maxLen);
      if (sglNewline > 0) {
        splitIndex = sglNewline + 1;
      } else {
        // Try space
        const space = remaining.lastIndexOf(' ', maxLen);
        if (space > 0) {
          splitIndex = space + 1;
        } else {
          // Hard split
          splitIndex = maxLen;
        }
      }
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

export class OpenWAGatewayAdapter implements GatewayAdapter {
  constructor(private readonly config: BotConfig) {}

  parse(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>
  ): ParseResult {
    try {
      // 1. Signature verification if secret is configured
      if (this.config.WEBHOOK_HMAC_SECRET) {
        const sigHeader = getHeader(headers, 'x-openwa-signature');
        const isValid = verifySignature(
          rawBody,
          sigHeader,
          this.config.WEBHOOK_HMAC_SECRET
        );
        if (!isValid) {
          return { kind: 'reject', status: 401 };
        }
      }

      // 2. JSON parse
      let payload: any;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return { kind: 'reject', status: 400 };
      }

      if (!payload || typeof payload !== 'object') {
        return { kind: 'reject', status: 400 };
      }

      // 3. Event and sessionId check
      if (payload.event !== 'message.received') {
        return { kind: 'ignore' };
      }
      if (
        this.config.OPENWA_SESSION_ID &&
        payload.sessionId !== this.config.OPENWA_SESSION_ID
      ) {
        return { kind: 'ignore' };
      }

      const data = payload.data;
      if (!data || typeof data !== 'object') {
        return { kind: 'ignore' };
      }

      // Ignore channels, statuses, broadcasts
      const kind = data.kind;
      if (kind === 'status' || kind === 'broadcast' || kind === 'channel') {
        return { kind: 'ignore' };
      }

      // Only text messages with non-empty string body
      if (data.type !== 'text' || typeof data.body !== 'string' || !data.body.trim()) {
        return { kind: 'ignore' };
      }

      // Parse id
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
      const senderId = String(data.author ?? data.from ?? '');

      let senderPhone: string | undefined;
      if (typeof data.senderPhone === 'string' && data.senderPhone.trim()) {
        const digits = data.senderPhone.replace(/\D/g, '');
        if (digits) senderPhone = digits;
      }

      const isGroup =
        data.isGroup === true || kind === 'group' || chatId.endsWith('@g.us');
      const fromMe = data.fromMe === true;

      // Timestamp parsing
      let timestampMs = Date.now();
      if (data.timestamp !== undefined && data.timestamp !== null) {
        const rawTs = Number(data.timestamp);
        if (!Number.isNaN(rawTs) && rawTs > 0) {
          timestampMs = rawTs >= 1e12 ? rawTs : rawTs * 1000;
        }
      }

      // Dedupe key
      const idempKeyHeader = getHeader(headers, 'x-openwa-idempotency-key');
      const dedupeKey =
        idempKeyHeader ||
        payload.idempotencyKey ||
        `msg_${this.config.OPENWA_SESSION_ID ?? ''}_${id}`;

      return {
        kind: 'message',
        msg: {
          id,
          dedupeKey,
          chatId,
          senderId,
          senderPhone,
          text,
          isGroup,
          fromMe,
          type: data.type,
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
    const sessionId = this.config.OPENWA_SESSION_ID ?? '';
    const endpointPath = this.config.sendTextPath.replace(
      '{sessionId}',
      encodeURIComponent(sessionId)
    );
    const url = `${this.config.OPENWA_BASE_URL}${endpointPath}`;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [this.config.apiKeyHeader]: this.config.OPENWA_API_KEY,
    };

    const body = JSON.stringify({ chatId, text });

    const max409Retries = 3;
    const backoff409 = [1000, 3000, 6000];

    const max5xxRetries = 2;
    const backoff5xx = [500, 1500];

    let attempt409 = 0;
    let attempt5xx = 0;
    let attempt429 = 0;

    while (true) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(15000),
        });

        if (res.ok) {
          return;
        }

        const status = res.status;
        const textBody = await res.text().catch(() => '');
        const truncated = textBody.slice(0, 200);

        if (status === 409) {
          if (attempt409 < max409Retries) {
            const delay = backoff409[attempt409];
            attempt409++;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw new GatewayError(status, `Gateway error 409: ${truncated}`);
        }

        if (status === 429) {
          let code: string | undefined;
          let retryAfter = 1;
          try {
            const parsed = JSON.parse(textBody);
            code = parsed.code;
            if (typeof parsed.retryAfterSeconds === 'number') {
              retryAfter = Math.min(Math.max(1, parsed.retryAfterSeconds), 10);
            }
          } catch {
            // ignore
          }

          if (code === 'SEND_PACING_LIMITED' && attempt429 === 0) {
            attempt429++;
            await new Promise((resolve) =>
              setTimeout(resolve, retryAfter * 1000)
            );
            continue;
          }

          throw new GatewayError(status, `Gateway rate limited 429: ${truncated}`);
        }

        if (status >= 500) {
          if (attempt5xx < max5xxRetries) {
            const delay = backoff5xx[attempt5xx];
            attempt5xx++;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw new GatewayError(status, `Gateway server error ${status}: ${truncated}`);
        }

        // 4xx other than 409/429
        throw new GatewayError(status, `Gateway client error ${status}: ${truncated}`);
      } catch (err: any) {
        if (err instanceof GatewayError) {
          throw err;
        }

        // Network error / abort timeout
        if (attempt5xx < max5xxRetries) {
          const delay = backoff5xx[attempt5xx];
          attempt5xx++;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        const msg = err instanceof Error ? err.message : String(err);
        // Ensure no API key in message
        const sanitizedMsg = msg.replace(this.config.OPENWA_API_KEY, '[REDACTED]');
        throw new GatewayError(0, `Gateway network error: ${sanitizedMsg}`);
      }
    }
  }

  async sendTyping(chatId: string, state: 'typing' | 'paused'): Promise<void> {
    try {
      if (!this.config.TYPING_INDICATOR) return;
      const sessionId = this.config.OPENWA_SESSION_ID ?? '';
      const url = `${this.config.OPENWA_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}/chats/typing`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [this.config.apiKeyHeader]: this.config.OPENWA_API_KEY,
        },
        body: JSON.stringify({ chatId, state }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Swallow all errors
    }
  }
}
