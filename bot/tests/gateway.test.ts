import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { OpenWAGatewayAdapter } from '../src/gateway/openwa';
import { WAAutomateGatewayAdapter } from '../src/gateway/waAutomate';
import type { BotConfig } from '../src/config';

describe('Gateway Adapters', () => {
  const secret = 'test-secret-at-least-16-bytes';
  const openwaConfig: BotConfig = {
    PORT: 3000,
    HOST: '127.0.0.1',
    OPENWA_FLAVOR: 'openwa-gateway',
    WEBHOOK_PATH_TOKEN: '123456789012345678901234',
    WEBHOOK_HMAC_SECRET: secret,
    OPENWA_SESSION_ID: 'test-session-123',
    OPENWA_BASE_URL: 'http://localhost:2785',
    OPENWA_API_KEY: 'test-api-key',
    apiKeyHeader: 'X-API-Key',
    sendTextPath: '/api/sessions/{sessionId}/messages/send-text',
    ALLOWED_SENDERS: 'david:254712345678@c.us',
    DB_HOST: 'localhost',
    DB_PORT: 3306,
    DB_USER: 'root',
    DB_PASSWORD: '',
    DB_NAME: 'shop',
    DB_SSL: false,
    GEMINI_API_KEY: 'test-gemini-key',
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

  const waAutomateConfig: BotConfig = {
    ...openwaConfig,
    OPENWA_FLAVOR: 'wa-automate',
    OPENWA_SESSION_ID: undefined,
    apiKeyHeader: 'api_key',
    sendTextPath: '/sendText',
  };

  function signBody(raw: Buffer, s = secret): string {
    const hex = crypto.createHmac('sha256', s).update(raw).digest('hex');
    return `sha256=${hex}`;
  }

  describe('openwa-gateway adapter', () => {
    const adapter = new OpenWAGatewayAdapter(openwaConfig);

    it('parses valid signed text DM fixture', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, 'fixtures/openwa-gateway/text_dm.json')
      );
      const headers = {
        'x-openwa-signature': signBody(raw),
        'x-openwa-idempotency-key': 'idemp_header_123',
      };

      const result = adapter.parse(raw, headers);
      expect(result.kind).toBe('message');
      if (result.kind === 'message') {
        expect(result.msg.id).toBe('msg_001');
        expect(result.msg.chatId).toBe('254712345678@c.us');
        expect(result.msg.senderId).toBe('254712345678@c.us');
        expect(result.msg.text).toBe('How many orders were placed?');
        expect(result.msg.isGroup).toBe(false);
        expect(result.msg.fromMe).toBe(false);
        expect(result.msg.dedupeKey).toBe('idemp_header_123');
        expect(result.msg.timestampMs).toBe(1760000000000);
      }
    });

    it('rejects with 401 when signature is wrong or missing', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, 'fixtures/openwa-gateway/text_dm.json')
      );
      expect(adapter.parse(raw, {}).kind).toBe('reject');
      expect(
        adapter.parse(raw, { 'x-openwa-signature': 'sha256=wrong' }).kind
      ).toBe('reject');
    });

    it('ignores session.status event', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, 'fixtures/openwa-gateway/session_status.json')
      );
      const headers = { 'x-openwa-signature': signBody(raw) };
      expect(adapter.parse(raw, headers)).toEqual({ kind: 'ignore' });
    });

    it('ignores other sessionIds', () => {
      const otherRaw = Buffer.from(
        JSON.stringify({
          event: 'message.received',
          sessionId: 'other-session-456',
          data: {
            id: 'msg_other',
            type: 'text',
            body: 'Hello',
            chatId: '123@c.us',
          },
        })
      );
      const headers = { 'x-openwa-signature': signBody(otherRaw) };
      expect(adapter.parse(otherRaw, headers)).toEqual({ kind: 'ignore' });
    });

    it('ignores image type', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, 'fixtures/openwa-gateway/image_dm.json')
      );
      const headers = { 'x-openwa-signature': signBody(raw) };
      expect(adapter.parse(raw, headers)).toEqual({ kind: 'ignore' });
    });

    it('ignores kind=status', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, 'fixtures/openwa-gateway/status_kind.json')
      );
      const headers = { 'x-openwa-signature': signBody(raw) };
      expect(adapter.parse(raw, headers)).toEqual({ kind: 'ignore' });
    });

    it('parses group message correctly with isGroup=true', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, 'fixtures/openwa-gateway/group_msg.json')
      );
      const headers = { 'x-openwa-signature': signBody(raw) };
      const res = adapter.parse(raw, headers);
      expect(res.kind).toBe('message');
      if (res.kind === 'message') {
        expect(res.msg.isGroup).toBe(true);
      }
    });

    it('parses fromMe=true correctly', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, 'fixtures/openwa-gateway/from_me.json')
      );
      const headers = { 'x-openwa-signature': signBody(raw) };
      const res = adapter.parse(raw, headers);
      expect(res.kind).toBe('message');
      if (res.kind === 'message') {
        expect(res.msg.fromMe).toBe(true);
      }
    });

    it('parses LID sender with senderPhone', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, 'fixtures/openwa-gateway/lid_sender.json')
      );
      const headers = { 'x-openwa-signature': signBody(raw) };
      const res = adapter.parse(raw, headers);
      expect(res.kind).toBe('message');
      if (res.kind === 'message') {
        expect(res.msg.senderId).toBe('98765432101234@lid');
        expect(res.msg.senderPhone).toBe('254712345678');
      }
    });

    it('returns 400 on malformed JSON', () => {
      const raw = Buffer.from('not json at all');
      const headers = { 'x-openwa-signature': signBody(raw) };
      expect(adapter.parse(raw, headers)).toEqual({
        kind: 'reject',
        status: 400,
      });
    });
  });

  describe('wa-automate adapter', () => {
    const adapter = new WAAutomateGatewayAdapter(waAutomateConfig);

    it('parses wrapped text DM fixture', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, 'fixtures/wa-automate/wrapped_dm.json')
      );
      const res = adapter.parse(raw, {});
      expect(res.kind).toBe('message');
      if (res.kind === 'message') {
        expect(res.msg.id).toBe('wam_001');
        expect(res.msg.text).toBe('Orders summary');
        expect(res.msg.chatId).toBe('254712345678@c.us');
        expect(res.msg.isGroup).toBe(false);
      }
    });

    it('parses bare text DM fixture', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, 'fixtures/wa-automate/bare_dm.json')
      );
      const res = adapter.parse(raw, {});
      expect(res.kind).toBe('message');
      if (res.kind === 'message') {
        expect(res.msg.id).toBe('wam_002');
        expect(res.msg.text).toBe('Bare message');
      }
    });

    it('parses group message with isGroup=true', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, 'fixtures/wa-automate/group_msg.json')
      );
      const res = adapter.parse(raw, {});
      expect(res.kind).toBe('message');
      if (res.kind === 'message') {
        expect(res.msg.isGroup).toBe(true);
      }
    });

    it('parses fromMe=true', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, 'fixtures/wa-automate/from_me.json')
      );
      const res = adapter.parse(raw, {});
      expect(res.kind).toBe('message');
      if (res.kind === 'message') {
        expect(res.msg.fromMe).toBe(true);
      }
    });

    it('ignores non-chat messages (e.g. image)', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, 'fixtures/wa-automate/image_msg.json')
      );
      expect(adapter.parse(raw, {})).toEqual({ kind: 'ignore' });
    });

    it('returns 400 on garbage JSON', () => {
      const raw = Buffer.from('{ corrupt json');
      expect(adapter.parse(raw, {})).toEqual({
        kind: 'reject',
        status: 400,
      });
    });
  });
});
