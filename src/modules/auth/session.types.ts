import type { PublicUser } from '../users';

/**
 * BE-01C — Session domain types.
 *
 * The raw session token is returned to the client once and never persisted;
 * only its SHA-256 hash is stored. Nothing in this module is exposed through
 * the API except the raw token at login time.
 */
export const SESSION_STATUSES = ['ACTIVE', 'REVOKED'] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type SessionRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  status: SessionStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

export type CreateSessionInput = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};

/** Result of login: the raw token plus the safe user identity. */
export type SessionResult = {
  sessionId: string;
  sessionToken: string;
  expiresAt: Date;
  user: PublicUser;
};

/** Authenticated request context attached by the authentication middleware. */
export type AuthContext = {
  userId: string;
  sessionId: string;
  user: PublicUser;
};
