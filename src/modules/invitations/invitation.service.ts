import { getAppConfig } from '../../config';
import { withTransaction } from '../../database';
import { logger } from '../../shared/logger';
import { recordEvent, type AuditRequestContext } from '../audit';
import { credentialRepository, passwordService } from '../auth';
import {
  normalizeDisplayName,
  normalizeEmail,
  toPublicUser,
  userEmailAlreadyExistsError,
  userRepository,
} from '../users';
import {
  invitationAlreadyAcceptedError,
  invitationAlreadyPendingError,
  invitationExpiredError,
  invitationNotFoundError,
  invitationRevokedError,
  invalidInvitationTokenError,
} from './invitation.errors';
import { invitationRepository } from './invitation.repository';
import { generateInvitationToken, hashInvitationToken } from './invitation.token';
import type {
  AcceptInvitationInput,
  InvitationRecord,
  PublicInvitation,
} from './invitation.types';

export type InvitationCreateResult = {
  invitation: PublicInvitation;
  invitationToken: string;
};

export function toPublicInvitation(record: InvitationRecord): PublicInvitation {
  return {
    id: record.id,
    email: record.email,
    status: record.status,
    expiresAt: record.expiresAt.toISOString(),
    invitedByUserId: record.invitedByUserId,
    acceptedByUserId: record.acceptedByUserId,
    acceptedAt: record.acceptedAt ? record.acceptedAt.toISOString() : null,
    revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Creates a PENDING invitation for a new email. Rejects existing identities
 * and existing valid pending invitations. The raw token is returned once and
 * never persisted.
 */
export async function createInvitation(
  email: string,
  invitedByUserId: string,
  audit: AuditRequestContext = {},
): Promise<InvitationCreateResult> {
  const normalized = normalizeEmail(email);

  const existingUser = await userRepository.findByEmail(normalized);
  if (existingUser) {
    throw userEmailAlreadyExistsError();
  }

  const existingPending = await invitationRepository.findPendingValidByEmail(
    normalized,
    new Date(),
  );
  if (existingPending) {
    throw invitationAlreadyPendingError();
  }

  const invitationToken = generateInvitationToken();
  const tokenHash = hashInvitationToken(invitationToken);
  const expiresAt = new Date(Date.now() + getAppConfig().invitation.ttlMs);

  const record = await invitationRepository.createInvitation({
    email: normalized,
    tokenHash,
    expiresAt,
    invitedByUserId,
  });

  await recordEvent({
    eventType: 'INVITATION_CREATED',
    outcome: 'SUCCESS',
    actorUserId: invitedByUserId,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
    metadata: { invitationId: record.id },
  });

  logger.info('Invitation created', {
    invitationId: record.id,
    actorUserId: invitedByUserId,
    action: 'invitation.create',
    result: 'success',
  });

  return {
    invitation: toPublicInvitation(record),
    invitationToken,
  };
}

/**
 * Accepts an invitation token. Runs atomically: lock invitation, validate,
 * create user + credential, mark ACCEPTED. No partial state on failure.
 */
export async function acceptInvitation(
  input: AcceptInvitationInput,
  audit: AuditRequestContext = {},
): Promise<{ user: ReturnType<typeof toPublicUser> }> {
  const tokenHash = hashInvitationToken(input.token);
  const displayName = normalizeDisplayName(input.displayName);
  // Reuses BE-01B password policy + hashing (throws PASSWORD_POLICY_VIOLATION).
  const passwordHash = await passwordService.hashPassword(input.password);

  try {
    const result = await withTransaction(async (client) => {
      const invitation = await invitationRepository.findByTokenHashForUpdate(
        client,
        tokenHash,
      );
      if (!invitation) {
        throw invalidInvitationTokenError();
      }

      if (invitation.status === 'ACCEPTED') {
        throw invitationAlreadyAcceptedError();
      }

      if (invitation.status === 'REVOKED') {
        throw invitationRevokedError();
      }

      if (invitation.expiresAt.getTime() <= Date.now()) {
        throw invitationExpiredError();
      }

      const existingUser = await userRepository.findByEmail(invitation.email, client);
      if (existingUser) {
        throw userEmailAlreadyExistsError();
      }

      const user = await userRepository.createUser(
        { email: invitation.email, displayName, status: 'ACTIVE' },
        client,
      );
      await credentialRepository.createForUser(
        { userId: user.id, passwordHash, mustChangePassword: false },
        client,
      );
      await invitationRepository.markAccepted(client, invitation.id, user.id, new Date());

      return { invitationId: invitation.id, user };
    });

    await recordEvent({
      eventType: 'INVITATION_ACCEPTED',
      outcome: 'SUCCESS',
      userId: result.user.id,
      requestId: audit.requestId ?? null,
      ipAddress: audit.ipAddress ?? null,
      userAgent: audit.userAgent ?? null,
      metadata: { invitationId: result.invitationId },
    });

    logger.info('Invitation accepted', {
      invitationId: result.invitationId,
      targetUserId: result.user.id,
      action: 'invitation.accept',
      result: 'success',
    });

    return { user: toPublicUser(result.user) };
  } catch (error) {
    if (isEmailUniqueViolation(error)) {
      throw userEmailAlreadyExistsError();
    }
    throw error;
  }
}

/** Revokes a PENDING invitation so its token can no longer be used. */
export async function revokeInvitation(
  id: string,
  actorUserId: string,
  audit: AuditRequestContext = {},
): Promise<PublicInvitation> {
  const invitation = await invitationRepository.findById(id);
  if (!invitation) {
    throw invitationNotFoundError();
  }

  if (invitation.status === 'ACCEPTED') {
    throw invitationAlreadyAcceptedError();
  }

  if (invitation.status === 'REVOKED') {
    return toPublicInvitation(invitation);
  }

  const updated = await invitationRepository.markRevoked(id, new Date());
  const record = updated ?? invitation;

  await recordEvent({
    eventType: 'INVITATION_REVOKED',
    outcome: 'SUCCESS',
    actorUserId,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
    metadata: { invitationId: id },
  });

  logger.info('Invitation revoked', {
    invitationId: id,
    actorUserId,
    action: 'invitation.revoke',
    result: 'success',
  });

  return toPublicInvitation(record);
}

function isEmailUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === 'users_email_unique';
}

export const invitationService = {
  acceptInvitation,
  createInvitation,
  revokeInvitation,
};
