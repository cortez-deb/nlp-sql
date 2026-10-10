import crypto from 'crypto';

/**
 * Verifies the X-OpenWA-Signature header against the raw body buffer.
 * Expected format: "sha256=<hex>"
 * Returns false and never throws on missing, malformed, or invalid signatures.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | string[] | undefined,
  secret: string
): boolean {
  try {
    if (!signatureHeader || !secret) {
      return false;
    }

    const header = Array.isArray(signatureHeader)
      ? signatureHeader[0]
      : signatureHeader;
    if (!header || typeof header !== 'string') {
      return false;
    }

    if (!header.startsWith('sha256=')) {
      return false;
    }

    const expectedHex = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    const expectedHeader = `sha256=${expectedHex}`;

    const providedBuf = Buffer.from(header, 'utf8');
    const expectedBuf = Buffer.from(expectedHeader, 'utf8');

    if (providedBuf.length !== expectedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}
