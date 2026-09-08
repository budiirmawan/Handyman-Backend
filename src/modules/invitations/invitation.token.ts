import { createHash, randomBytes } from 'node:crypto';

export const INVITATION_TOKEN_BYTES = 32;

/**
 * Opaque invitation token utilities. Tokens come from cryptographically
 * secure randomness and are stored only as a SHA-256 hash.
 */
export function generateInvitationToken(bytes: number = INVITATION_TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
