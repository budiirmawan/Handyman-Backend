import {
  credentialNotFoundError,
  credentialService,
  sessionService,
} from '../auth';
import { recordEvent, type AuditRequestContext } from '../audit';
import { withTransaction } from '../../database';
import { logger } from '../../shared/logger';
import {
  invalidAccountStateError,
  lastOwnerAccountProtectedError,
  selfAccountActionDeniedError,
  userNotFoundError,
} from './user.errors';
import { toPublicUser } from './user.mapper';
import {
  PROTECTED_ROLE_CODE,
  assertActorMayModifyAccount,
  assertActorMayResetPassword,
} from './privileged-account.guard';
import { userRepository } from './user.repository';
import type { PublicUser, UserStatus } from './user.types';
import type { AuditEventType } from '../audit';

/**
 * Serializes account-status transitions so the last-owner check cannot race
 * two concurrent suspensions into a zero-owner installation. Independent of
 * the bootstrap advisory lock (724196032).
 */
const ACCOUNT_LIFECYCLE_LOCK = 724196033;

/**
 * Account lifecycle transitions are centralized here so no controller updates
 * User status directly. Deactivation/suspension also revoke active sessions so
 * an old session cannot bypass the new account state. Every transition records
 * a persistent audit event distinguishing the actor from the affected user.
 */
async function transition(
  userId: string,
  from: UserStatus | readonly UserStatus[],
  to: UserStatus,
  eventType: AuditEventType,
  revokeSessions: boolean,
  audit: AuditRequestContext = {},
): Promise<PublicUser> {
  const actorUserId = audit.actorUserId ?? null;

  // CR-HM-IAM-BOOTSTRAP-01 HARDENING — authorization is resolved server-side
  // inside the same transaction as the status write:
  //   - an administrator may never transition their own account,
  //   - an owner account may only be transitioned by another owner,
  //   - the last ACTIVE owner account can never be deactivated or suspended.
  const updated = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [
      ACCOUNT_LIFECYCLE_LOCK,
    ]);

    const user = await userRepository.findById(userId, client);
    if (!user) {
      throw userNotFoundError();
    }

    const allowedFrom = Array.isArray(from) ? from : [from];
    if (!allowedFrom.includes(user.status)) {
      throw invalidAccountStateError();
    }

    if (actorUserId !== null && actorUserId === userId) {
      throw selfAccountActionDeniedError();
    }

    await assertActorMayModifyAccount({
      targetUserId: userId,
      actorUserId,
      client,
    });

    if (to !== 'ACTIVE') {
      const targetIsOwner = await userRepository.hasActiveRole(
        userId,
        PROTECTED_ROLE_CODE,
        client,
      );
      if (targetIsOwner) {
        const remainingOwners = await userRepository.countActiveRoleHolders(
          PROTECTED_ROLE_CODE,
          { excludeUserId: userId },
          client,
        );
        if (remainingOwners === 0) {
          throw lastOwnerAccountProtectedError();
        }
      }
    }

    const stored = await userRepository.updateStatus(userId, to, client);
    if (!stored) {
      throw userNotFoundError();
    }
    if (revokeSessions) {
      // Status and session invalidation commit (or roll back) together.
      await sessionService.revokeActiveSessionsForUser(userId, client);
    }
    return stored;
  });

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

/** INACTIVE/SUSPENDED → ACTIVE (does not restore old sessions). */
export async function reactivateUser(
  userId: string,
  audit?: AuditRequestContext,
): Promise<PublicUser> {
  return transition(
    userId,
    ['INACTIVE', 'SUSPENDED'],
    'ACTIVE',
    'ACCOUNT_REACTIVATED',
    false,
    audit,
  );
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
  await assertActorMayResetPassword(userId, audit.actorUserId);

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
