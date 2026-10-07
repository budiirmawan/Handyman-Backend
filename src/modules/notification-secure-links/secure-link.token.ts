import { createHash, randomBytes } from 'node:crypto';

/**
 * BE-26J — Secure link token utilities.
 *
 * Mirrors the BE-01C session / BE-01G invitation token convention: tokens are
 * generated from cryptographically secure randomness, returned to the caller
 * exactly once, and stored only as a SHA-256 hash. SHA-256 (not bcrypt) is
 * correct here because these are high-entropy random tokens, not user-chosen
 * passwords.
 */

export const SECURE_LINK_TOKEN_BYTES = 32;

export function generateSecureLinkToken(
  bytes: number = SECURE_LINK_TOKEN_BYTES,
): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashSecureLinkToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
