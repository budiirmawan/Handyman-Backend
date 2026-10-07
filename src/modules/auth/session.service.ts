import { getAppConfig } from '../../config';
import { logger } from '../../shared/logger';
import {
  toPublicUser,
  userRepository,
  userService,
  userStatusCanLogin,
} from '../users';
import { invalidSessionError, sessionExpiredError } from './session.errors';
import { sessionRepository } from './session.repository';
import {
  generateSessionToken,
  hashSessionToken,
} from './session.token';
import type { AuthContext, SessionResult } from './session.types';

/**
 * Creates a new session for an authenticated user. The raw token is returned
 * once; only its hash is persisted.
 */
export async function createSessionForUser(userId: string): Promise<SessionResult> {
  const user = await userService.getUserById(userId);

  const sessionConfig = getAppConfig().session;
  const sessionToken = generateSessionToken(sessionConfig.tokenBytes);
  const tokenHash = hashSessionToken(sessionToken);
  const expiresAt = new Date(Date.now() + sessionConfig.ttlMs);

  const session = await sessionRepository.createSession({
    userId,
    tokenHash,
    expiresAt,
  });

  logger.info('Session created', {
    userId,
    sessionId: session.id,
    operation: 'session.create',
  });

  return {
    sessionId: session.id,
    sessionToken,
    expiresAt: session.expiresAt,
    user,
  };
}

/**
 * Resolves a raw session token to an authenticated context. Hashes the token,
 * looks up the session, validates status + expiry, and revalidates the user's
 * account state. Throws controlled 401 errors on failure.
 */
export async function resolveSessionContext(rawToken: string): Promise<AuthContext> {
  const tokenHash = hashSessionToken(rawToken);
  const session = await sessionRepository.findByTokenHash(tokenHash);

  if (!session || session.status !== 'ACTIVE') {
    throw invalidSessionError();
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    throw sessionExpiredError();
  }

  const userRecord = await userRepository.findById(session.userId);
  if (!userRecord || !userStatusCanLogin(userRecord.status)) {
    throw invalidSessionError();
  }

  const user = toPublicUser(userRecord);

  const now = new Date();
  await sessionRepository.markUsedIfStale(
    session.id,
    now,
    getAppConfig().session.lastUsedUpdateIntervalMs,
  );

  return {
    userId: session.userId,
    sessionId: session.id,
    user,
  };
}

/**
 * Revokes an active session without deleting the row.
 */
export async function revokeSessionById(id: string): Promise<void> {
  const revoked = await sessionRepository.revokeById(id, new Date());
  if (!revoked) {
    throw invalidSessionError();
  }

  logger.info('Session revoked', {
    sessionId: id,
    userId: revoked.userId,
    operation: 'session.revoke',
  });
}

/**
 * Revokes all active sessions for a user. Used by account lifecycle so that
 * deactivated/suspended accounts cannot keep using an existing session.
 */
export async function revokeActiveSessionsForUser(userId: string): Promise<void> {
  const count = await sessionRepository.revokeActiveByUserId(userId, new Date());

  if (count > 0) {
    logger.info('Sessions revoked for user', {
      userId,
      operation: 'session.revoke_all',
      result: 'success',
    });
  }
}

export const sessionService = {
  createSessionForUser,
  resolveSessionContext,
  revokeActiveSessionsForUser,
  revokeSessionById,
};
