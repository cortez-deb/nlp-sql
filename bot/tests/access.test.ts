import {
  AccessController,
  parseAllowedSenders,
  maskSenderId,
} from '../src/access';
import type { InboundMessage } from '../src/gateway';

describe('Access Control', () => {
  describe('parseAllowedSenders', () => {
    it('parses valid single and multiple entries', () => {
      const map = parseAllowedSenders(
        'david:254712345678@c.us,david:98765432101234@lid'
      );
      expect(map.get('254712345678@c.us')).toBe('david');
      expect(map.get('98765432101234@lid')).toBe('david');
    });

    it('throws on invalid ownerId', () => {
      expect(() => parseAllowedSenders('bad/owner:123@c.us')).toThrow();
      expect(() => parseAllowedSenders(':123@c.us')).toThrow();
      expect(() => parseAllowedSenders('-invalid:123@c.us')).toThrow();
    });

    it('throws on missing colon or empty chatId', () => {
      expect(() => parseAllowedSenders('david')).toThrow();
      expect(() => parseAllowedSenders('david:')).toThrow();
    });
  });

  describe('maskSenderId', () => {
    it('masks all but last 4 characters', () => {
      expect(maskSenderId('254712345678@c.us')).toBe(
        '****************5678@c.us'.slice(0, '254712345678@c.us'.length - 4) +
          'c.us'
      );
      expect(maskSenderId('1234')).toBe('****');
      expect(maskSenderId('12')).toBe('****');
    });
  });

  describe('AccessController.check', () => {
    const rawAllowlist =
      'david:254712345678@c.us,david:98765432101234@lid,alice:254799999999@c.us';
    const controller = new AccessController(rawAllowlist, 120);

    const baseMsg: InboundMessage = {
      id: 'msg_1',
      dedupeKey: 'key_1',
      chatId: '254712345678@c.us',
      senderId: '254712345678@c.us',
      text: 'Hello world',
      isGroup: false,
      fromMe: false,
      type: 'text',
      timestampMs: 1000000,
    };

    it('accepts valid message from allowlisted sender', () => {
      const res = controller.check(baseMsg, 1005000);
      expect(res.allowed).toBe(true);
      if (res.allowed) {
        expect(res.ownerId).toBe('david');
      }
    });

    it('rejects group messages', () => {
      const res = controller.check({ ...baseMsg, dedupeKey: 'k2', isGroup: true }, 1005000);
      expect(res.allowed).toBe(false);
      expect((res as any).reason).toBe('group');
    });

    it('rejects fromMe messages', () => {
      const res = controller.check({ ...baseMsg, dedupeKey: 'k3', fromMe: true }, 1005000);
      expect(res.allowed).toBe(false);
      expect((res as any).reason).toBe('fromMe');
    });

    it('rejects unknown senders', () => {
      const res = controller.check(
        { ...baseMsg, dedupeKey: 'k4', chatId: 'stranger@c.us', senderId: 'stranger@c.us' },
        1005000
      );
      expect(res.allowed).toBe(false);
      expect((res as any).reason).toBe('unknown_sender');
    });

    it('accepts @lid when mapped in allowlist', () => {
      const res = controller.check(
        { ...baseMsg, dedupeKey: 'k5', chatId: '98765432101234@lid', senderId: '98765432101234@lid' },
        1005000
      );
      expect(res.allowed).toBe(true);
      if (res.allowed) {
        expect(res.ownerId).toBe('david');
      }
    });

    it('accepts @lid sender via senderPhone when resolved', () => {
      const res = controller.check(
        {
          ...baseMsg,
          dedupeKey: 'k6',
          chatId: 'otherlid@lid',
          senderId: 'otherlid@lid',
          senderPhone: '254799999999',
        },
        1005000
      );
      expect(res.allowed).toBe(true);
      if (res.allowed) {
        expect(res.ownerId).toBe('alice');
      }
    });

    it('drops old messages exceeding MAX_MESSAGE_AGE_SEC', () => {
      // 1000000 + 130 seconds = 1130000
      const res = controller.check({ ...baseMsg, dedupeKey: 'k7' }, 1000000 + 130 * 1000);
      expect(res.allowed).toBe(false);
      expect((res as any).reason).toBe('expired');
    });

    it('drops duplicate messages via dedupeKey', () => {
      const first = controller.check({ ...baseMsg, dedupeKey: 'dup_key' }, 1005000);
      expect(first.allowed).toBe(true);

      const second = controller.check({ ...baseMsg, dedupeKey: 'dup_key' }, 1005000);
      expect(second.allowed).toBe(false);
      expect((second as any).reason).toBe('duplicate');
    });

    it('drops empty or whitespace-only text', () => {
      const res = controller.check({ ...baseMsg, dedupeKey: 'k8', text: '   ' }, 1005000);
      expect(res.allowed).toBe(false);
      expect((res as any).reason).toBe('empty');
    });

    it('rejects text longer than 1000 chars with specific reply', () => {
      const longText = 'a'.repeat(1001);
      const res = controller.check({ ...baseMsg, dedupeKey: 'k9', text: longText }, 1005000);
      expect(res.allowed).toBe(false);
      expect((res as any).reason).toBe('too_long');
      expect((res as any).reply).toBe('That message is too long. Please shorten it.');
    });
  });
});
