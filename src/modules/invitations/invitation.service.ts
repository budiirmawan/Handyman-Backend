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
  InvitationListStatus,
  InvitationRecord,
  InvitationStatus,
  PublicInvitation,
} from './invitation.types';

export type InvitationCreateResult = {
  invitation: PublicInvitation;
  invitationToken: string;
  delivery: {
    available: boolean;
    method: 'CONTROLLED_ONE_TIME_HANDOFF';
    provider: string;
    sent: false;
    note: string;
  };
};

export type InvitationListResult = {
  items: PublicInvitation[];
  total: number;
};

/** Public (unauthenticated) validation view returned from token validation. */
export type InvitationValidationView = {
  tokenValid: true;
  invitationId: string;
  email: string;
  status: InvitationStatus;
  expiresAt: string;
};

function deliveryContext(): InvitationCreateResult['delivery'] {
  const provider = getAppConfig().email.provider;
  // The shared email adapter is not wired to user invitations. Do not claim
  // SMTP delivery just because a provider is configured: this endpoint only
  // supports a controlled, authorized, one-time token handoff in its response.
  return {
    available: false,
    method: 'CONTROLLED_ONE_TIME_HANDOFF',
    provider,
    sent: false,
    note:
      provider === 'noop'
        ? 'EMAIL_PROVIDER=noop: invitation email delivery is unavailable. Use the returned one-time token for controlled out-of-band handoff; no email was sent.'
        : 'Automated invitation email delivery is not wired. Use the returned one-time token for controlled out-of-band handoff; no email was sent.',
  };
}

export function toPublicInvitation(record: InvitationRecord): PublicInvitation {
  const status =
    record.status === 'PENDING' && record.expiresAt.getTime() <= Date.now()
      ? 'EXPIRED'
      : record.status;
  return {
    id: record.id,
    email: record.email,
    status,
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
  const invitationToken = generateInvitationToken();
  const tokenHash = hashInvitationToken(invitationToken);
  const expiresAt = new Date(Date.now() + getAppConfig().invitation.ttlMs);

  // Serialize creation by normalized email. The existing schema has a unique
  // token-hash index but intentionally permits historical invitation rows;
  // the transaction lock closes the concurrent duplicate-PENDING race.
  const record = await withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 72104))',
      [normalized],
    );

    const existingUser = await userRepository.findByEmail(normalized, client);
    if (existingUser) {
      throw userEmailAlreadyExistsError();
    }

    const existingPending = await invitationRepository.findPendingValidByEmail(
      normalized,
      new Date(),
      client,
    );
    if (existingPending) {
      throw invitationAlreadyPendingError();
    }

    return invitationRepository.createInvitation(
      {
        email: normalized,
        tokenHash,
        expiresAt,
        invitedByUserId,
      },
      client,
    );
  });

  await recordEvent({
    eventType: 'INVITATION_CREATED',
    outcome: 'SUCCESS',
    actorUserId: invitedByUserId,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
    metadata: { invitationId: record.id, targetEmail: normalized },
  });

  const delivery = deliveryContext();

  logger.info('Invitation created', {
    invitationId: record.id,
    actorUserId: invitedByUserId,
    action: 'invitation.create',
    result: 'success',
  });

  return {
    invitation: toPublicInvitation(record),
    invitationToken,
    delivery,
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

  // Reject obviously invalid/unusable tokens before paying the bcrypt cost.
  // The row is checked again under FOR UPDATE below to close revoke/replay
  // races; this preflight is only a resource-abuse guard, not the authority.
  const preflight = await invitationRepository.findByTokenHash(tokenHash);
  if (!preflight) {
    throw invalidInvitationTokenError();
  }
  if (preflight.status === 'ACCEPTED') {
    throw invitationAlreadyAcceptedError();
  }
  if (preflight.status === 'REVOKED') {
    throw invitationRevokedError();
  }
  if (preflight.expiresAt.getTime() <= Date.now()) {
    throw invitationExpiredError();
  }

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
      actorUserId: result.user.id,
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

/**
 * Lists invitations (administrative). Supports optional email + status
 * filters and bounded pagination. Token hashes are never returned.
 */
export async function listInvitations(filters: {
  email?: string;
  status?: InvitationListStatus;
  page: number;
  pageSize: number;
}): Promise<InvitationListResult> {
  const limit = Math.min(Math.max(1, Math.floor(filters.pageSize)), 200);
  const page = Math.max(1, Math.floor(filters.page));
  const offset = (page - 1) * limit;

  const { rows, total } = await invitationRepository.listInvitations({
    email: filters.email?.trim() ? normalizeEmail(filters.email) : undefined,
    status: filters.status,
    limit,
    offset,
  });

  return { items: rows.map(toPublicInvitation), total };
}

/** Retrieves a single invitation by id (administrative). */
export async function getInvitation(id: string): Promise<PublicInvitation> {
  const record = await invitationRepository.findById(id);
  if (!record) {
    throw invitationNotFoundError();
  }
  return toPublicInvitation(record);
}

/**
 * Public (unauthenticated) token validation used by the acceptance UI to
 * show status BEFORE the candidate types a password. Returns a generic 404
 * for unknown/rehashed/garbage tokens to avoid email enumeration.
 */
export async function validateInvitationToken(
  token: string,
): Promise<InvitationValidationView> {
  const tokenHash = hashInvitationToken(token);
  const record = await invitationRepository.findByTokenHash(tokenHash);
  if (!record) {
    throw invalidInvitationTokenError();
  }

  if (record.status === 'REVOKED') {
    throw invitationRevokedError();
  }
  if (record.status === 'ACCEPTED') {
    throw invitationAlreadyAcceptedError();
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    throw invitationExpiredError();
  }

  return {
    tokenValid: true,
    invitationId: record.id,
    email: record.email,
    status: record.status,
    expiresAt: record.expiresAt.toISOString(),
  };
}

/** Revokes a PENDING invitation so its token can no longer be used. */
export async function revokeInvitation(
  id: string,
  actorUserId: string,
  audit: AuditRequestContext = {},
): Promise<PublicInvitation> {
  const result = await withTransaction(async (client) => {
    const invitation = await invitationRepository.findByIdForUpdate(client, id);
    if (!invitation) {
      throw invitationNotFoundError();
    }

    if (invitation.status === 'ACCEPTED') {
      throw invitationAlreadyAcceptedError();
    }

    if (invitation.status === 'REVOKED') {
      return { record: invitation, changed: false };
    }

    const updated = await invitationRepository.markRevoked(
      client,
      id,
      new Date(),
    );
    if (!updated) {
      throw invitationNotFoundError();
    }
    return { record: updated, changed: true };
  });

  if (result.changed) {
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
  }

  return toPublicInvitation(result.record);
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
  getInvitation,
  listInvitations,
  revokeInvitation,
  validateInvitationToken,
};
