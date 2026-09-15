/**
 * BE-26J — Notification secure link types.
 *
 * A secure link is an opaque, recipient-bound, single-purpose reference to a
 * target resource + action. The raw token never embeds the resource id; the
 * target lives server-side and is revealed only after authenticated
 * validation. No credentials or sensitive data are embedded.
 */

export const SECURE_LINK_STATUSES = [
  'ACTIVE',
  'REVOKED',
  'EXPIRED',
  'USED',
] as const;

export type SecureLinkStatus = (typeof SECURE_LINK_STATUSES)[number];

export function isSecureLinkStatus(value: unknown): value is SecureLinkStatus {
  return (
    typeof value === 'string' &&
    (SECURE_LINK_STATUSES as readonly string[]).includes(value)
  );
}

/** The raw persisted shape of a secure link row (token_hash is never exposed). */
export type SecureLinkRecord = {
  id: string;
  tokenHash: string;
  clientId: string;
  recipientUserId: string;
  targetEntityType: string;
  targetEntityId: string;
  action: string;
  expiresAt: Date;
  maxUses: number;
  usedCount: number;
  status: SecureLinkStatus;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Safe public representation exposed through the API. The token hash is
 * intentionally omitted — the raw token is returned exactly once at creation.
 */
export type PublicSecureLink = Omit<
  SecureLinkRecord,
  'tokenHash' | 'expiresAt' | 'createdAt' | 'updatedAt'
> & {
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateSecureLinkInput = {
  clientId: string;
  recipientUserId: string;
  targetEntityType: string;
  targetEntityId: string;
  action: string;
  expiresAt: string;
  maxUses?: number;
};

/** Creation result: the public record plus the raw token (returned once). */
export type CreatedSecureLink = {
  link: PublicSecureLink;
  token: string;
};
