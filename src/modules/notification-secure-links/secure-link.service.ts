import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { secureLinkRepository } from './secure-link.repository';
import {
  secureLinkAlreadyUsedError,
  secureLinkExpiredError,
  secureLinkNotActiveError,
  secureLinkNotFoundError,
  secureLinkRevokedError,
} from './secure-link.errors';
import {
  generateSecureLinkToken,
  hashSecureLinkToken,
} from './secure-link.token';
import type {
  CreatedSecureLink,
  CreateSecureLinkInput,
  PublicSecureLink,
  SecureLinkRecord,
} from './secure-link.types';

/**
 * BE-26J — Notification secure link service.
 *
 * A secure link is an opaque, recipient-bound, single-purpose reference to a
 * target resource + action:
 *   - `createSecureLink` — generates the opaque token, stores only its hash,
 *     and returns the raw token exactly once,
 *   - `resolveSecureLink` — validates the token (recipient binding, expiry,
 *     revocation, usage) and consumes a use; returns the target,
 *   - `revokeSecureLink` / `getSecureLink` — revocation + status inspection.
 *
 * The link does NOT bypass backend authorization/workflow rules: resolution
 * only returns the target reference; the actual action is performed through
 * normal authorized endpoints (RBAC + available_actions remain authoritative).
 */

export function toPublicSecureLink(record: SecureLinkRecord): PublicSecureLink {
  return {
    id: record.id,
    clientId: record.clientId,
    recipientUserId: record.recipientUserId,
    targetEntityType: record.targetEntityType,
    targetEntityId: record.targetEntityId,
    action: record.action,
    expiresAt: record.expiresAt.toISOString(),
    maxUses: record.maxUses,
    usedCount: record.usedCount,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Validates that the bound recipient is an existing ACTIVE user. */
async function assertActiveRecipient(userId: string): Promise<void> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE'`,
    [userId],
  );
  if (result.rows.length === 0) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'recipientUserId',
        message: 'recipientUserId must reference an active user.',
      },
    ]);
  }
}

/** Creates a secure link; returns the public record and the raw token (once). */
export async function createSecureLink(
  input: CreateSecureLinkInput,
): Promise<CreatedSecureLink> {
  await assertActiveRecipient(input.recipientUserId);

  const token = generateSecureLinkToken();
  const tokenHash = hashSecureLinkToken(token);

  const record = await secureLinkRepository.create({
    tokenHash,
    clientId: input.clientId,
    recipientUserId: input.recipientUserId,
    targetEntityType: input.targetEntityType,
    targetEntityId: input.targetEntityId,
    action: input.action,
    expiresAt: new Date(input.expiresAt),
    maxUses: input.maxUses ?? 1,
  });

  return { link: toPublicSecureLink(record), token };
}

/**
 * Resolves (and consumes) a secure link for the authenticated recipient.
 * Rejects unknown/mismatched tokens (no leak), expired, revoked, and
 * exhausted links.
 */
export async function resolveSecureLink(
  token: string,
  recipientUserId: string,
): Promise<PublicSecureLink> {
  const tokenHash = hashSecureLinkToken(token);
  const record = await secureLinkRepository.findByTokenHash(tokenHash);

  // Unknown token OR token bound to another user → identical NOT_FOUND.
  if (!record || record.recipientUserId !== recipientUserId) {
    throw secureLinkNotFoundError();
  }

  if (record.status === 'REVOKED') {
    throw secureLinkRevokedError();
  }
  if (record.status === 'EXPIRED') {
    throw secureLinkExpiredError();
  }
  if (record.status === 'USED' || record.usedCount >= record.maxUses) {
    throw secureLinkAlreadyUsedError();
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    await secureLinkRepository.markExpired(record.id);
    throw secureLinkExpiredError();
  }

  const consumed = await secureLinkRepository.markUsed(record.id);
  if (!consumed) {
    // Race: another resolve consumed the final use first.
    throw secureLinkAlreadyUsedError();
  }
  return toPublicSecureLink(consumed);
}

/** Returns a secure link's current status (non-consuming). */
export async function getSecureLink(id: string): Promise<PublicSecureLink> {
  const record = await secureLinkRepository.findById(id);
  if (!record) {
    throw secureLinkNotFoundError();
  }
  return toPublicSecureLink(record);
}

/** Revokes an ACTIVE link (ACTIVE → REVOKED). */
export async function revokeSecureLink(id: string): Promise<PublicSecureLink> {
  const record = await secureLinkRepository.markRevoked(id);
  if (!record) {
    const existing = await secureLinkRepository.findById(id);
    if (!existing) {
      throw secureLinkNotFoundError();
    }
    throw secureLinkNotActiveError();
  }
  return toPublicSecureLink(record);
}

export const secureLinkService = {
  createSecureLink,
  getSecureLink,
  resolveSecureLink,
  revokeSecureLink,
  toPublicSecureLink,
};
