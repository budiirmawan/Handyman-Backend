import type { PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import {
  privilegedAccountProtectedError,
  privilegedAccountResetDeniedError,
} from './user.errors';
import { userRepository } from './user.repository';

/**
 * CR-HM-IAM-BOOTSTRAP-01 HARDENING — central guard for operations on
 * privileged (owner) accounts.
 *
 * The Owner role code is a literal here on purpose: the users module must not
 * import the iam-bootstrap module (which depends on users). The value is the
 * same authoritative code defined by `iam-canonical-roles.ts` and created by
 * the foundation seed.
 *
 * Rules:
 *   - a target that holds ACTIVE PLATFORM_ADMIN may only be modified by an
 *     actor that also holds it — `user.manage` alone is never enough,
 *   - a missing actor is a denial (fail closed), never an implicit allow,
 *   - the check runs inside the caller's transaction when a client is passed,
 *     so it cannot race with a concurrent revocation of the actor's role.
 */
export const PROTECTED_ROLE_CODE = 'PLATFORM_ADMIN';
export const AUTHORITY_DEFINING_PERMISSIONS: readonly string[] = [
  'role.manage',
  'permission.manage',
];

export async function isPrivilegedAccount(
  userId: string,
  client?: PoolClient,
): Promise<boolean> {
  return userRepository.hasActiveRole(userId, PROTECTED_ROLE_CODE, client);
}

export type ProtectedAccountCheck = {
  targetUserId: string;
  actorUserId: string | null | undefined;
  client?: PoolClient;
  denial?: () => AppError;
};

/**
 * Asserts the actor may modify the target account. Non-privileged targets are
 * always allowed (route-level `user.manage` still applies); privileged targets
 * require an owner actor.
 */
export async function assertActorMayModifyAccount(
  check: ProtectedAccountCheck,
): Promise<void> {
  const targetPrivileged = await isPrivilegedAccount(
    check.targetUserId,
    check.client,
  );
  if (!targetPrivileged) {
    return;
  }

  const actorPrivileged = check.actorUserId
    ? await isPrivilegedAccount(check.actorUserId, check.client)
    : false;

  if (!actorPrivileged) {
    throw (check.denial ?? privilegedAccountProtectedError)();
  }
}

/** Password-reset variant: keeps the dedicated, observable denial code. */
export function assertActorMayResetPassword(
  targetUserId: string,
  actorUserId: string | null | undefined,
): Promise<void> {
  return assertActorMayModifyAccount({
    targetUserId,
    actorUserId,
    denial: privilegedAccountResetDeniedError,
  });
}

export const privilegedAccountGuard = {
  assertActorMayModifyAccount,
  assertActorMayResetPassword,
  isPrivilegedAccount,
};
