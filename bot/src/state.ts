import type { ConversationTurn } from 'nlsql';

export interface ChatState {
  turns: ConversationTurn[];
  lastQuery: { question: string; sql: string } | null;
  lastSeen: number;
  queue: Promise<void>;
}

export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number = 2) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.active--;
        this.next();
      };
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.next();
        });
      });
    });
  }

  private next(): void {
    if (this.active < this.max && this.queue.length > 0) {
      const fn = this.queue.shift();
      if (fn) fn();
    }
  }
}

export class ChatStateStore {
  private chats = new Map<string, ChatState>();
  private readonly maxChats = 100;
  private readonly idleTimeoutMs = 2 * 60 * 60 * 1000; // 2 hours

  get(chatId: string): ChatState {
    this.cleanup();

    let state = this.chats.get(chatId);
    if (!state) {
      if (this.chats.size >= this.maxChats) {
        this.evictOldest();
      }
      state = {
        turns: [],
        lastQuery: null,
        lastSeen: Date.now(),
        queue: Promise.resolve(),
      };
      this.chats.set(chatId, state);
    } else {
      state.lastSeen = Date.now();
    }

    return state;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, state] of this.chats.entries()) {
      if (now - state.lastSeen > this.idleTimeoutMs) {
        this.chats.delete(id);
      }
    }
  }

  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, state] of this.chats.entries()) {
      if (state.lastSeen < oldestTime) {
        oldestTime = state.lastSeen;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.chats.delete(oldestId);
    }
  }

  clear(): void {
    this.chats.clear();
  }
}

export class RateLimiter {
  private chatTimestamps = new Map<string, number[]>();
  private dailyCount = 0;
  private currentDay = '';

  constructor(
    private readonly limitPerMin: number = 10,
    private readonly dailyLimit: number = 200
  ) {}

  check(chatId: string, now = Date.now()): { allowed: boolean; reason?: 'per_min' | 'daily' } {
    const today = new Date(now).toLocaleDateString('en-CA');
    if (this.currentDay !== today) {
      this.currentDay = today;
      this.dailyCount = 0;
    }

    if (this.dailyCount >= this.dailyLimit) {
      return { allowed: false, reason: 'daily' };
    }

    const windowStart = now - 60000;
    const timestamps = (this.chatTimestamps.get(chatId) ?? []).filter((t) => t > windowStart);
    this.chatTimestamps.set(chatId, timestamps);

    if (timestamps.length >= this.limitPerMin) {
      return { allowed: false, reason: 'per_min' };
    }

    return { allowed: true };
  }

  record(chatId: string, now = Date.now()): void {
    const today = new Date(now).toLocaleDateString('en-CA');
    if (this.currentDay !== today) {
      this.currentDay = today;
      this.dailyCount = 0;
    }

    this.dailyCount++;

    const windowStart = now - 60000;
    const timestamps = (this.chatTimestamps.get(chatId) ?? []).filter((t) => t > windowStart);
    timestamps.push(now);
    this.chatTimestamps.set(chatId, timestamps);
  }
}
