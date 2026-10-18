import {
  credentialNotFoundError,
  credentialService,
  sessionService,
} from '../auth';
import { recordEvent, type AuditRequestContext } from '../audit';
import { logger } from '../../shared/logger';
import {
  invalidAccountStateError,
  privilegedAccountResetDeniedError,
  userNotFoundError,
} from './user.errors';
import { toPublicUser } from './user.mapper';
import { userRepository } from './user.repository';
import type { PublicUser, UserStatus } from './user.types';
import type { AuditEventType } from '../audit';

/**
 * Account lifecycle transitions are centralized here so no controller updates
 * User status directly. Deactivation/suspension also revoke active sessions so
 * an old session cannot bypass the new account state. Every transition records
 * a persistent audit event distinguishing the actor from the affected user.
 */
async function transition(
  userId: string,
  from: UserStatus,
  to: UserStatus,
  eventType: AuditEventType,
  revokeSessions: boolean,
  audit: AuditRequestContext = {},
): Promise<PublicUser> {
  const user = await userRepository.findById(userId);
  if (!user) {
    throw userNotFoundError();
  }

  if (user.status !== from) {
    throw invalidAccountStateError();
  }

  const updated = await userRepository.updateStatus(userId, to);
  if (!updated) {
    throw userNotFoundError();
  }

  if (revokeSessions) {
    await sessionService.revokeActiveSessionsForUser(userId);
  }

  await recordEvent({
    eventType,
    outcome: 'SUCCESS',
    userId,
    actorUserId: audit.actorUserId ?? null,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
  });

  logger.info('Account lifecycle transition applied', {
    targetUserId: userId,
    actorUserId: audit.actorUserId,
    action: `account.${to.toLowerCase()}`,
    result: 'success',
  });

  return toPublicUser(updated);
}

/** ACTIVE → INACTIVE (administrative access disabled). */
export async function deactivateUser(
  userId: string,
  audit?: AuditRequestContext,
): Promise<PublicUser> {
  return transition(userId, 'ACTIVE', 'INACTIVE', 'ACCOUNT_DEACTIVATED', true, audit);
}

/** ACTIVE → SUSPENDED (security/administrative access blocked). */
export async function suspendUser(
  userId: string,
  audit?: AuditRequestContext,
): Promise<PublicUser> {
  return transition(userId, 'ACTIVE', 'SUSPENDED', 'ACCOUNT_SUSPENDED', true, audit);
}

/** INACTIVE → ACTIVE (does not restore old sessions). */
export async function reactivateUser(
  userId: string,
  audit?: AuditRequestContext,
): Promise<PublicUser> {
  return transition(userId, 'INACTIVE', 'ACTIVE', 'ACCOUNT_REACTIVATED', false, audit);
}

export type UserPasswordResetResult = {
  reset: true;
  mustChangePassword: true;
};

/**
 * CR-HM-IAM-BOOTSTRAP-01 — administrative password reset (`user.manage`).
 *
 * Rules:
 *   - the account must exist and must already have a credential,
 *   - the new secret is validated/hashed by the existing credential service
 *     (policy + bcrypt); only the hash is stored,
 *   - EVERY active session is revoked BEFORE the new hash is written, so a
 *     stolen session cannot survive a reset (fail-safe ordering),
 *   - `must_change_password` is set so the temporary secret is one-time,
 *   - neither the plaintext nor the hash is returned or logged; the audit
 *     event carries ids only.
 */
export async function resetUserPassword(
  userId: string,
  newPassword: string,
  audit: AuditRequestContext = {},
): Promise<UserPasswordResetResult> {
  const user = await userRepository.findById(userId);
  if (!user) {
    throw userNotFoundError();
  }

  // Account-takeover guard: a non-owner must never reset an owner credential,
  // even when it holds `user.manage` (e.g. SYSTEM_ADMIN).
  if (await userRepository.hasActiveRole(userId, 'PLATFORM_ADMIN')) {
    const actorIsOwner = audit.actorUserId
      ? await userRepository.hasActiveRole(audit.actorUserId, 'PLATFORM_ADMIN')
      : false;
    if (!actorIsOwner) {
      throw privilegedAccountResetDeniedError();
    }
  }

  const credential = await credentialService.getCredentialByUserId(userId);
  if (!credential) {
    throw credentialNotFoundError();
  }

  // Fail-safe: cut existing sessions first, then replace the hash.
  await sessionService.revokeActiveSessionsForUser(userId);
  await credentialService.resetPassword(userId, newPassword);

  await recordEvent({
    eventType: 'PASSWORD_RESET',
    outcome: 'SUCCESS',
    userId,
    actorUserId: audit.actorUserId ?? null,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
  });

  logger.info('Administrative password reset applied', {
    targetUserId: userId,
    actorUserId: audit.actorUserId,
    action: 'account.password_reset',
    result: 'success',
  });

  return { reset: true, mustChangePassword: true };
}

export const userLifecycleService = {
  deactivateUser,
  reactivateUser,
  resetUserPassword,
  suspendUser,
};
