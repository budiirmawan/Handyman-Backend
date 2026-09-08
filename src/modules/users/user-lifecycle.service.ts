import { sessionService } from '../auth';
import { recordEvent, type AuditRequestContext } from '../audit';
import { logger } from '../../shared/logger';
import { invalidAccountStateError, userNotFoundError } from './user.errors';
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

export const userLifecycleService = {
  deactivateUser,
  reactivateUser,
  suspendUser,
};
