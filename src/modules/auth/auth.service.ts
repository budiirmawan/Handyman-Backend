import { logger } from '../../shared/logger';
import {
  recordEvent,
  type AuditRequestContext,
} from '../audit';
import {
  normalizeEmail,
  userRepository,
  userStatusCanLogin,
} from '../users';
import { authRateLimitedError, invalidCredentialsError } from './auth.errors';
import { credentialRepository } from './credential.repository';
import { credentialService } from './credential.service';
import {
  isLoginRateLimited,
  recordLoginFailure,
  recordLoginSuccess,
} from './login-rate-limit';
import { passwordService } from './password.service';
import {
  createSessionForUser,
  revokeOtherSessionsForUser,
} from './session.service';
import type { SessionResult } from './session.types';

export type LoginInput = {
  email: string;
  password: string;
};

/**
 * Email + password login. Unknown email, wrong password, and non-active
 * account states all produce the same generic 401 INVALID_CREDENTIALS to
 * avoid account enumeration. Repeated failures are throttled in-memory
 * (per-IP). Success and failure both produce persistent audit events.
 */
export async function login(
  input: LoginInput,
  audit: AuditRequestContext = {},
): Promise<SessionResult> {
  const email = normalizeEmail(input.email);
  const rateKey = audit.ipAddress ?? 'unknown';

  if (isLoginRateLimited(rateKey)) {
    throw authRateLimitedError();
  }

  const user = await userRepository.findByEmail(email);

  if (!user || !userStatusCanLogin(user.status)) {
    await recordLoginFailure(rateKey);
    await recordLoginFailureAudit(audit, user?.id ?? null);
    throw invalidCredentialsError();
  }

  const credential = await credentialRepository.findByUserId(user.id);
  if (!credential) {
    await recordLoginFailure(rateKey);
    await recordLoginFailureAudit(audit, user.id);
    throw invalidCredentialsError();
  }

  const valid = await passwordService.verifyPassword(
    input.password,
    credential.passwordHash,
  );
  if (!valid) {
    await recordLoginFailure(rateKey);
    await recordLoginFailureAudit(audit, user.id);
    throw invalidCredentialsError();
  }

  const result = await createSessionForUser(user.id);
  recordLoginSuccess(rateKey);

  await recordEvent({
    eventType: 'LOGIN_SUCCESS',
    outcome: 'SUCCESS',
    userId: user.id,
    sessionId: result.sessionId,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
  });

  logger.info('Login succeeded', {
    userId: user.id,
    sessionId: result.sessionId,
    operation: 'auth.login',
    result: 'success',
  });

  return result;
}

function recordLoginFailureAudit(
  audit: AuditRequestContext,
  userId: string | null,
): Promise<void> {
  return recordEvent({
    eventType: 'LOGIN_FAILED',
    outcome: 'FAILURE',
    userId,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
    metadata: { reason: 'INVALID_CREDENTIALS' },
  });
}

export type ChangePasswordInput = {
  userId: string;
  sessionId: string;
  currentPassword: string;
  newPassword: string;
};

/**
 * CR-HM-IAM-BOOTSTRAP-01 — authenticated self-service password change.
 *
 * Verifies the CURRENT password first (the credential service returns
 * INVALID_PASSWORD on mismatch, never distinguishing unknown users), applies
 * the existing password policy + bcrypt, then revokes every OTHER session so a
 * stolen token cannot survive a password change. The calling session stays
 * valid. Only ids/codes are audited.
 */
export async function changePassword(
  input: ChangePasswordInput,
  audit: AuditRequestContext = {},
): Promise<{ changed: true }> {
  await credentialService.changeOwnPassword(
    input.userId,
    input.currentPassword,
    input.newPassword,
  );

  await revokeOtherSessionsForUser(input.userId, input.sessionId);

  await recordEvent({
    eventType: 'PASSWORD_CHANGED',
    outcome: 'SUCCESS',
    userId: input.userId,
    sessionId: input.sessionId,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
  });

  logger.info('Password changed', {
    userId: input.userId,
    sessionId: input.sessionId,
    operation: 'auth.change_password',
    result: 'success',
  });

  return { changed: true };
}

export const authService = {
  changePassword,
  login,
};
