import crypto from 'crypto';
import { verifySignature } from '../src/gateway/signature';

describe('Signature verification (HMAC SHA-256)', () => {
  const secret = 'super-secret-key-at-least-16-bytes';
  const rawBody = Buffer.from('{"hello":"world"}', 'utf8');

  const validHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const validHeader = `sha256=${validHex}`;

  it('accepts valid signature header', () => {
    expect(verifySignature(rawBody, validHeader, secret)).toBe(true);
  });

  it('accepts signature header when passed as string array', () => {
    expect(verifySignature(rawBody, [validHeader], secret)).toBe(true);
  });

  it('rejects wrong signature', () => {
    const wrongHex = crypto.createHmac('sha256', 'wrong-secret-key-16-bytes').update(rawBody).digest('hex');
    expect(verifySignature(rawBody, `sha256=${wrongHex}`, secret)).toBe(false);
  });

  it('rejects missing header (undefined, null, empty)', () => {
    expect(verifySignature(rawBody, undefined, secret)).toBe(false);
    expect(verifySignature(rawBody, '', secret)).toBe(false);
  });

  it('rejects missing secret', () => {
    expect(verifySignature(rawBody, validHeader, '')).toBe(false);
  });

  it('rejects truncated signature', () => {
    expect(verifySignature(rawBody, validHeader.slice(0, 20), secret)).toBe(false);
  });

  it('rejects wrong prefix (e.g. sha1= or no prefix)', () => {
    expect(verifySignature(rawBody, `sha1=${validHex}`, secret)).toBe(false);
    expect(verifySignature(rawBody, validHex, secret)).toBe(false);
  });

  it('rejects length-mismatch headers without throwing', () => {
    expect(verifySignature(rawBody, 'sha256=too-short', secret)).toBe(false);
    expect(verifySignature(rawBody, `sha256=${validHex}extra-chars`, secret)).toBe(false);
  });

  it('never throws on unexpected inputs or malformed characters', () => {
    expect(verifySignature(rawBody, 'sha256=\u0000\uFFFF', secret)).toBe(false);
    expect(verifySignature(rawBody, {} as any, secret)).toBe(false);
  });
});
