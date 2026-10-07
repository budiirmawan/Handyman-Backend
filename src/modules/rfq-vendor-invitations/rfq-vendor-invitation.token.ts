import { createHash, randomBytes } from 'node:crypto';

/**
 * CR-BE-PRO-02 PART 02 — high-entropy external RFQ token utilities.
 *
 * Invitation and external-session bearer tokens are generated from secure
 * randomness and stored only as SHA-256 digests. They are separate token
 * classes so a consumed invitation token can never be reused as a session.
 */
export const RFQ_VENDOR_INVITATION_TOKEN_BYTES = 32;
export const RFQ_VENDOR_SESSION_TOKEN_BYTES = 32;

export function generateRfqVendorInvitationToken(): string {
  return randomBytes(RFQ_VENDOR_INVITATION_TOKEN_BYTES).toString('base64url');
}

export function hashRfqVendorInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateRfqVendorSessionToken(): string {
  return randomBytes(RFQ_VENDOR_SESSION_TOKEN_BYTES).toString('base64url');
}

export function hashRfqVendorSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
