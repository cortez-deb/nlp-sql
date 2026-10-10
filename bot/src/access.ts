import type { InboundMessage } from './gateway/types';

const OWNER_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class SimpleLru<K, V = boolean> {
  private map = new Map<K, V>();
  constructor(private readonly maxSize = 500) {}

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }
}

export function parseAllowedSenders(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const pairs = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const pair of pairs) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(
        `Invalid ALLOWED_SENDERS entry "${pair}": must be in format ownerId:chatId`
      );
    }

    const ownerId = pair.slice(0, colonIdx).trim();
    const chatId = pair.slice(colonIdx + 1).trim();

    if (!OWNER_ID_REGEX.test(ownerId)) {
      throw new Error(
        `Invalid ownerId "${ownerId}" in ALLOWED_SENDERS. Must match regex ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`
      );
    }

    if (!chatId) {
      throw new Error(`Empty chatId for ownerId "${ownerId}" in ALLOWED_SENDERS`);
    }

    map.set(chatId, ownerId);
  }

  return map;
}

export function maskSenderId(id: string): string {
  if (id.length <= 4) return '****';
  return '*'.repeat(id.length - 4) + id.slice(-4);
}

export type AccessDecision =
  | { allowed: true; ownerId: string }
  | {
      allowed: false;
      reason:
        | 'group'
        | 'fromMe'
        | 'expired'
        | 'empty'
        | 'too_long'
        | 'duplicate'
        | 'unknown_sender';
      reply?: string;
    };

export class AccessController {
  private allowedSenders: Map<string, string>;
  public dedupeLru: SimpleLru<string, boolean>;
  private processedKeys = new SimpleLru<string, boolean>(500);
  private warnedSenders = new Set<string>();

  constructor(
    allowedSendersRaw: string,
    private readonly maxMessageAgeSec = 120,
    dedupeLru?: SimpleLru<string, boolean>
  ) {
    this.allowedSenders = parseAllowedSenders(allowedSendersRaw);
    this.dedupeLru = dedupeLru ?? new SimpleLru<string, boolean>(500);
  }

  check(msg: InboundMessage, now = Date.now()): AccessDecision {
    if (msg.isGroup) {
      return { allowed: false, reason: 'group' };
    }

    if (msg.fromMe) {
      return { allowed: false, reason: 'fromMe' };
    }

    // Message age check
    if (this.maxMessageAgeSec > 0) {
      const ageSec = (now - msg.timestampMs) / 1000;
      if (ageSec > this.maxMessageAgeSec) {
        return { allowed: false, reason: 'expired' };
      }
    }

    // Dedupe check
    if (this.processedKeys.has(msg.dedupeKey)) {
      return { allowed: false, reason: 'duplicate' };
    }

    // Text content checks
    const trimmed = msg.text.trim();
    if (!trimmed) {
      return { allowed: false, reason: 'empty' };
    }

    if (trimmed.length > 1000) {
      return {
        allowed: false,
        reason: 'too_long',
        reply: 'That message is too long. Please shorten it.',
      };
    }

    // Allowlist check
    let matchedOwnerId: string | undefined;

    if (this.allowedSenders.has(msg.chatId)) {
      matchedOwnerId = this.allowedSenders.get(msg.chatId);
    } else if (this.allowedSenders.has(msg.senderId)) {
      matchedOwnerId = this.allowedSenders.get(msg.senderId);
    } else if (msg.senderPhone && this.allowedSenders.has(`${msg.senderPhone}@c.us`)) {
      matchedOwnerId = this.allowedSenders.get(`${msg.senderPhone}@c.us`);
    }

    if (!matchedOwnerId) {
      return { allowed: false, reason: 'unknown_sender' };
    }

    // Record dedupe key upon acceptance
    this.processedKeys.set(msg.dedupeKey, true);
    this.dedupeLru.set(msg.dedupeKey, true);

    return { allowed: true, ownerId: matchedOwnerId };
  }

  isWarned(senderId: string): boolean {
    return this.warnedSenders.has(senderId);
  }

  markWarned(senderId: string): void {
    this.warnedSenders.add(senderId);
  }
}
