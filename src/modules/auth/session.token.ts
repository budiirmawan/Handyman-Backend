import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque session token utilities.
 *
 * Tokens are generated from cryptographically secure randomness, returned to
 * the client once, and stored only as a SHA-256 hash. SHA-256 (not bcrypt) is
 * used here because these are high-entropy random tokens, not user-chosen
 * passwords.
 */
export function generateSessionToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
