import { createHmac, timingSafeEqual } from 'node:crypto';

/** Headers checked, in order. Razorpay's own header is accepted for drop-in use. */
export const SIGNATURE_HEADERS = ['x-webhook-signature', 'x-razorpay-signature'];

export function signPayload(rawBody, secret) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Constant-time check of a hex HMAC-SHA256 signature computed over the exact
 * raw request bytes. Accepts an optional "sha256=" prefix.
 */
export function verifySignature(rawBody, signature, secret) {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const provided = Buffer.from(signature.trim().toLowerCase().replace(/^sha256=/, ''), 'utf8');
  const expected = Buffer.from(signPayload(rawBody, secret), 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
