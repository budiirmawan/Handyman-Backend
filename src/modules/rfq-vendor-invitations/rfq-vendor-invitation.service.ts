import { createHash } from 'node:crypto';
import { getAppConfig } from '../../config';
import { withTransaction } from '../../database';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { rfqRepository } from '../rfqs';
import type { RfqRecord, RfqLineRecord } from '../rfqs';
import { rfqVendorInvitationRepository } from './rfq-vendor-invitation.repository';
import {
  generateRfqVendorInvitationToken,
  generateRfqVendorSessionToken,
  hashRfqVendorInvitationToken,
  hashRfqVendorSessionToken,
} from './rfq-vendor-invitation.token';
import {
  rfqVendorInvitationActionNotAllowedError,
  rfqVendorInvitationAlreadyActiveError,
  rfqVendorInvitationContextMismatchError,
  rfqVendorInvitationIdempotencyConflictError,
  rfqVendorInvitationIdempotencyKeyRequiredError,
  rfqVendorInvitationNotOpenError,
  rfqVendorInvitationNotRevocableError,
  rfqVendorInvitationNotFoundError,
  rfqVendorInvitationRfqInvalidError,
  rfqVendorInvitationTokenExpiredError,
  rfqVendorInvitationTokenInvalidError,
  rfqVendorInvitationTokenReplayedError,
  rfqVendorInvitationVendorInvalidError,
  rfqVendorSessionExpiredError,
  rfqVendorSessionInvitationMismatchError,
  rfqVendorSessionNotFoundError,
  rfqVendorSessionRevokedError,
  rfqVendorSessionRfqMismatchError,
} from './rfq-vendor-invitation.errors';
import type {
  CreateRfqVendorInvitationInput,
  PublicRfqVendorAccessSession,
  PublicRfqVendorInvitation,
  RfqVendorAccessSessionRecord,
  RfqVendorExchangeResult,
  RfqVendorInvitationCreateResult,
  RfqVendorInvitationFilters,
  RfqVendorInvitationRecord,
  RfqVendorSessionContext,
  ResendRfqVendorInvitationInput,
  RfqVendorAction,
  VendorSafeRfq,
} from './rfq-vendor-invitation.types';

const UNIQUE_VIOLATION = '23505';
const ACTIVE_INVITATION_STATUSES = ['INVITED', 'ACCEPTED'] as const;

type VendorScope = {
  id: string;
  clientId: string;
  vendorName: string;
  email: string | null;
  status: string;
};

type VendorBuildingScope = {
  status: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
};

function toPublicInvitation(
  record: RfqVendorInvitationRecord,
): PublicRfqVendorInvitation {
  return {
    id: record.id,
    rfqId: record.rfqId,
    vendorId: record.vendorId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    attemptNumber: record.attemptNumber,
    status: record.status,
    responseDeadline: record.responseDeadlineSnapshot.toISOString(),
    tokenExpiresAt: record.tokenExpiresAt.toISOString(),
    tokenConsumedAt: record.tokenConsumedAt?.toISOString() ?? null,
    contactSourceType: record.contactSourceType,
    contactSourceId: record.contactSourceId,
    contactNameSnapshot: record.contactNameSnapshot,
    recipientEmailSnapshot: record.recipientEmailSnapshot,
    viewedAt: record.viewedAt?.toISOString() ?? null,
    acceptedAt: record.acceptedAt?.toISOString() ?? null,
    declinedAt: record.declinedAt?.toISOString() ?? null,
    noBidAt: record.noBidAt?.toISOString() ?? null,
    expiredAt: record.expiredAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    revokedByUserId: record.revokedByUserId,
    responseReason: record.responseReason,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicSession(
  record: RfqVendorAccessSessionRecord,
): PublicRfqVendorAccessSession {
  return {
    id: record.id,
    invitationId: record.invitationId,
    rfqId: record.rfqId,
    vendorId: record.vendorId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    status: record.status,
    issuedAt: record.issuedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    expiredAt: record.expiredAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function uniqueConstraint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === UNIQUE_VIOLATION && typeof candidate.constraint === 'string'
    ? candidate.constraint
    : undefined;
}

function fingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isWithinWindow(
  effectiveFrom: Date | null,
  effectiveUntil: Date | null,
  now = Date.now(),
): boolean {
  return (
    (effectiveFrom === null || effectiveFrom.getTime() <= now) &&
    (effectiveUntil === null || effectiveUntil.getTime() >= now)
  );
}

async function loadVendorForUpdate(
  client: import('pg').PoolClient,
  vendorId: string,
): Promise<VendorScope | null> {
  const result = await client.query<VendorScope>(
    `SELECT id, client_id AS "clientId", vendor_name AS "vendorName",
            email, status
       FROM vendors
      WHERE id = $1
      FOR UPDATE`,
    [vendorId],
  );
  return result.rows[0] ?? null;
}

async function loadVendorBuildingForUpdate(
  client: import('pg').PoolClient,
  vendorId: string,
  buildingId: string,
): Promise<VendorBuildingScope | null> {
  const result = await client.query<VendorBuildingScope>(
    `SELECT status,
            effective_from AS "effectiveFrom",
            effective_until AS "effectiveUntil"
       FROM vendor_building_relationships
      WHERE vendor_id = $1 AND building_id = $2 AND status = 'ACTIVE'
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [vendorId, buildingId],
  );
  return result.rows[0] ?? null;
}

function assertVendorCanReceive(
  rfq: RfqRecord,
  vendor: VendorScope | null,
  relationship: VendorBuildingScope | null,
): asserts vendor is VendorScope {
  if (!vendor || vendor.status !== 'ACTIVE') {
    throw rfqVendorInvitationVendorInvalidError();
  }
  if (vendor.clientId !== rfq.clientId) {
    throw rfqVendorInvitationContextMismatchError();
  }
  if (!relationship || relationship.status !== 'ACTIVE' || !isWithinWindow(
    relationship.effectiveFrom,
    relationship.effectiveUntil,
  )) {
    throw rfqVendorInvitationVendorInvalidError();
  }
}

function assertOpenRfq(rfq: RfqRecord | null): asserts rfq is RfqRecord {
  if (!rfq) throw rfqVendorInvitationRfqInvalidError();
  if (
    rfq.status !== 'OPEN' ||
    !rfq.responseDeadline ||
    rfq.responseDeadline.getTime() <= Date.now()
  ) {
    throw rfqVendorInvitationNotOpenError();
  }
}

function tokenExpiresAt(rfq: RfqRecord, issuedAt: Date): Date {
  const configured = new Date(issuedAt.getTime() + getAppConfig().invitation.ttlMs);
  const deadline = rfq.responseDeadline as Date;
  return configured < deadline ? configured : deadline;
}

function sessionExpiresAt(invitation: RfqVendorInvitationRecord, issuedAt: Date): Date {
  const configured = new Date(issuedAt.getTime() + getAppConfig().session.ttlMs);
  return configured < invitation.responseDeadlineSnapshot
    ? configured
    : invitation.responseDeadlineSnapshot;
}

async function loadAccessibleInvitation(
  invitationId: string,
  actorUserId: string,
): Promise<RfqVendorInvitationRecord> {
  const invitation = await rfqVendorInvitationRepository.findById(invitationId);
  if (!invitation) throw rfqVendorInvitationNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, invitation.buildingId);
  return invitation;
}

function createFingerprint(input: CreateRfqVendorInvitationInput): string {
  return fingerprint({ command: 'CREATE', rfqId: input.rfqId, vendorId: input.vendorId });
}

function resendFingerprint(input: ResendRfqVendorInvitationInput): string {
  return fingerprint({ command: 'RESEND', invitationId: input.invitationId });
}

async function createInvitationRow(
  client: import('pg').PoolClient,
  rfq: RfqRecord,
  vendor: VendorScope,
  input: { idempotencyKey: string; idempotencyFingerprint: string },
  actorUserId: string,
): Promise<{ record: RfqVendorInvitationRecord; token: string }> {
  const issuedAt = new Date();
  const token = generateRfqVendorInvitationToken();
  const record = await rfqVendorInvitationRepository.createIdempotent(client, {
    rfqId: rfq.id,
    vendorId: vendor.id,
    clientId: rfq.clientId,
    buildingId: rfq.buildingId,
    attemptNumber: await rfqVendorInvitationRepository.nextAttemptNumber(
      client,
      rfq.id,
      vendor.id,
    ),
    responseDeadlineSnapshot: rfq.responseDeadline as Date,
    tokenHash: hashRfqVendorInvitationToken(token),
    tokenExpiresAt: tokenExpiresAt(rfq, issuedAt),
    contactNameSnapshot: vendor.vendorName,
    recipientEmailSnapshot: vendor.email,
    idempotencyKey: input.idempotencyKey,
    idempotencyFingerprint: input.idempotencyFingerprint,
    createdByUserId: actorUserId,
  });

  if (!record.created) {
    throw new Error('createInvitationRow must be called only for a new idempotency key');
  }
  return { record: record.record, token };
}

/** Creates one idempotent internal Vendor invitation and returns its token once. */
export async function createRfqVendorInvitation(
  input: CreateRfqVendorInvitationInput,
  actorUserId: string,
): Promise<RfqVendorInvitationCreateResult> {
  if (!input.idempotencyKey.trim()) throw rfqVendorInvitationIdempotencyKeyRequiredError();
  const rfq = await rfqRepository.findById(input.rfqId);
  if (!rfq) throw rfqVendorInvitationRfqInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, rfq.buildingId);

  const result = await withTransaction(async (client) => {
    const lockedRfq = await rfqRepository.findByIdForUpdate(client, rfq.id);
    if (!lockedRfq) throw rfqVendorInvitationRfqInvalidError();

    const existing = await rfqVendorInvitationRepository.findByIdempotencyKeyForUpdate(
      client,
      lockedRfq.clientId,
      input.idempotencyKey,
    );
    const expectedFingerprint = createFingerprint(input);
    if (existing) {
      if (existing.idempotencyFingerprint !== expectedFingerprint) {
        throw rfqVendorInvitationIdempotencyConflictError();
      }
      return { record: existing, token: null, created: false };
    }

    assertOpenRfq(lockedRfq);
    const vendor = await loadVendorForUpdate(client, input.vendorId);
    const relationship = await loadVendorBuildingForUpdate(
      client,
      input.vendorId,
      lockedRfq.buildingId,
    );
    assertVendorCanReceive(lockedRfq, vendor, relationship);

    if (await rfqVendorInvitationRepository.findActiveByRfqAndVendor(
      client,
      lockedRfq.id,
      input.vendorId,
    )) {
      throw rfqVendorInvitationAlreadyActiveError();
    }

    const created = await createInvitationRow(
      client,
      lockedRfq,
      vendor,
      { idempotencyKey: input.idempotencyKey, idempotencyFingerprint: expectedFingerprint },
      actorUserId,
    );

    await recordOperationalEvent(
      {
        clientId: created.record.clientId,
        buildingId: created.record.buildingId,
        eventType: 'RFQ_VENDOR_INVITATION_CREATED',
        entityType: 'RFQ_VENDOR_INVITATION',
        entityId: created.record.id,
        actorUserId,
        summary: `Vendor invitation created for RFQ ${lockedRfq.rfqNumber}.`,
        metadata: {
          rfqId: lockedRfq.id,
          vendorId: created.record.vendorId,
          attemptNumber: created.record.attemptNumber,
          hasRecipientEmail: created.record.recipientEmailSnapshot !== null,
        },
      },
      client,
    );

    if (created.record.recipientEmailSnapshot === null) {
      await recordOperationalEvent(
        {
          clientId: created.record.clientId,
          buildingId: created.record.buildingId,
          eventType: 'RFQ_VENDOR_INVITATION_NOTIFICATION_SKIPPED',
          entityType: 'RFQ_VENDOR_INVITATION',
          entityId: created.record.id,
          actorUserId,
          summary: 'Vendor invitation notification skipped because no Vendor email exists.',
          metadata: { rfqId: lockedRfq.id, vendorId: created.record.vendorId, reason: 'NO_VENDOR_EMAIL' },
        },
        client,
      );
    }

    return { record: created.record, token: created.token, created: true };
  });

  return {
    invitation: toPublicInvitation(result.record),
    invitationToken: result.token,
    created: result.created,
  };
}

export async function getRfqVendorInvitation(
  invitationId: string,
  actorUserId: string,
): Promise<PublicRfqVendorInvitation> {
  return toPublicInvitation(await loadAccessibleInvitation(invitationId, actorUserId));
}

export async function listRfqVendorInvitations(
  rfqId: string,
  filters: RfqVendorInvitationFilters,
  actorUserId: string,
): Promise<PublicRfqVendorInvitation[]> {
  const rfq = await rfqRepository.findById(rfqId);
  if (!rfq) throw rfqVendorInvitationRfqInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, rfq.buildingId);
  return (await rfqVendorInvitationRepository.listByRfq(rfqId, filters)).map(toPublicInvitation);
}

export async function listAccessibleRfqVendorInvitations(
  filters: RfqVendorInvitationFilters,
  actorUserId: string,
): Promise<PublicRfqVendorInvitation[]> {
  if (filters.vendorId) {
    // Vendor filtering is still narrowed by accessible Buildings in SQL.
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (await rfqVendorInvitationRepository.listByBuilding(buildingIds, filters)).map(toPublicInvitation);
}

/** Resends an invitation by creating a new attempt and invalidating old access. */
export async function resendRfqVendorInvitation(
  input: ResendRfqVendorInvitationInput,
  actorUserId: string,
): Promise<RfqVendorInvitationCreateResult> {
  if (!input.idempotencyKey.trim()) throw rfqVendorInvitationIdempotencyKeyRequiredError();
  const existing = await loadAccessibleInvitation(input.invitationId, actorUserId);
  const rfq = await rfqRepository.findById(existing.rfqId);
  if (!rfq) throw rfqVendorInvitationRfqInvalidError();

  const result = await withTransaction(async (client) => {
    const oldInvitation = await rfqVendorInvitationRepository.findByIdForUpdate(
      client,
      input.invitationId,
    );
    if (!oldInvitation) throw rfqVendorInvitationNotFoundError();
    const lockedRfq = await rfqRepository.findByIdForUpdate(client, oldInvitation.rfqId);
    assertOpenRfq(lockedRfq);

    const expectedFingerprint = resendFingerprint(input);
    const replay = await rfqVendorInvitationRepository.findByIdempotencyKeyForUpdate(
      client,
      lockedRfq.clientId,
      input.idempotencyKey,
    );
    if (replay) {
      if (replay.idempotencyFingerprint !== expectedFingerprint) {
        throw rfqVendorInvitationIdempotencyConflictError();
      }
      return { record: replay, token: null, created: false };
    }

    const vendor = await loadVendorForUpdate(client, oldInvitation.vendorId);
    const relationship = await loadVendorBuildingForUpdate(
      client,
      oldInvitation.vendorId,
      lockedRfq.buildingId,
    );
    assertVendorCanReceive(lockedRfq, vendor, relationship);

    if ((ACTIVE_INVITATION_STATUSES as readonly string[]).includes(oldInvitation.status)) {
      await rfqVendorInvitationRepository.markRevokedWithClient(
        client,
        oldInvitation.id,
        actorUserId,
      );
      await recordOperationalEvent(
        {
          clientId: oldInvitation.clientId,
          buildingId: oldInvitation.buildingId,
          eventType: 'RFQ_VENDOR_INVITATION_REVOKED',
          entityType: 'RFQ_VENDOR_INVITATION',
          entityId: oldInvitation.id,
          actorUserId,
          summary: 'Prior Vendor RFQ invitation revoked during resend.',
          metadata: { rfqId: oldInvitation.rfqId, vendorId: oldInvitation.vendorId, reason: 'RESENT' },
        },
        client,
      );
    }
    await rfqVendorInvitationRepository.revokeActiveSessionsWithClient(client, oldInvitation.id);

    const created = await createInvitationRow(
      client,
      lockedRfq,
      vendor,
      { idempotencyKey: input.idempotencyKey, idempotencyFingerprint: expectedFingerprint },
      actorUserId,
    );
    await recordOperationalEvent(
      {
        clientId: created.record.clientId,
        buildingId: created.record.buildingId,
        eventType: 'RFQ_VENDOR_INVITATION_RESENT',
        entityType: 'RFQ_VENDOR_INVITATION',
        entityId: created.record.id,
        actorUserId,
        summary: `Vendor invitation resent for RFQ ${lockedRfq.rfqNumber}.`,
        metadata: {
          rfqId: lockedRfq.id,
          vendorId: created.record.vendorId,
          priorInvitationId: oldInvitation.id,
          attemptNumber: created.record.attemptNumber,
          hasRecipientEmail: created.record.recipientEmailSnapshot !== null,
        },
      },
      client,
    );
    return { record: created.record, token: created.token, created: true };
  });

  return { invitation: toPublicInvitation(result.record), invitationToken: result.token, created: result.created };
}

export async function revokeRfqVendorInvitation(
  invitationId: string,
  actorUserId: string,
): Promise<PublicRfqVendorInvitation> {
  await loadAccessibleInvitation(invitationId, actorUserId);
  return withTransaction(async (client) => {
    const invitation = await rfqVendorInvitationRepository.findByIdForUpdate(client, invitationId);
    if (!invitation) throw rfqVendorInvitationNotFoundError();
    if (invitation.status === 'REVOKED') return toPublicInvitation(invitation);
    if (!(ACTIVE_INVITATION_STATUSES as readonly string[]).includes(invitation.status)) {
      throw rfqVendorInvitationNotRevocableError();
    }

    const revoked = await rfqVendorInvitationRepository.markRevokedWithClient(
      client,
      invitation.id,
      actorUserId,
    );
    if (!revoked) throw rfqVendorInvitationNotRevocableError();
    await rfqVendorInvitationRepository.revokeActiveSessionsWithClient(client, invitation.id);
    await recordOperationalEvent(
      {
        clientId: revoked.clientId,
        buildingId: revoked.buildingId,
        eventType: 'RFQ_VENDOR_INVITATION_REVOKED',
        entityType: 'RFQ_VENDOR_INVITATION',
        entityId: revoked.id,
        actorUserId,
        summary: 'Vendor RFQ invitation revoked.',
        metadata: { rfqId: revoked.rfqId, vendorId: revoked.vendorId },
      },
      client,
    );
    return toPublicInvitation(revoked);
  });
}

async function expireInvitationIfNeeded(
  client: import('pg').PoolClient,
  invitation: RfqVendorInvitationRecord,
  reason: string,
): Promise<void> {
  if (!(ACTIVE_INVITATION_STATUSES as readonly string[]).includes(invitation.status)) return;
  const expired = await rfqVendorInvitationRepository.markExpiredWithClient(client, invitation.id);
  if (!expired) return;
  await rfqVendorInvitationRepository.revokeActiveSessionsWithClient(client, invitation.id);
  await recordOperationalEvent(
    {
      clientId: expired.clientId,
      buildingId: expired.buildingId,
      eventType: 'RFQ_VENDOR_INVITATION_EXPIRED',
      entityType: 'RFQ_VENDOR_INVITATION',
      entityId: expired.id,
      actorUserId: null,
      summary: 'Vendor RFQ invitation expired.',
      metadata: { rfqId: expired.rfqId, vendorId: expired.vendorId, reason },
    },
    client,
  );
}

/** Exchanges a one-time invitation token for a dedicated external session. */
export async function exchangeRfqVendorInvitationToken(
  token: string,
): Promise<RfqVendorExchangeResult> {
  const tokenHash = hashRfqVendorInvitationToken(token);
  const result = await withTransaction(async (client) => {
    const invitation = await rfqVendorInvitationRepository.findByTokenHashForUpdate(
      client,
      tokenHash,
    );
    if (!invitation) throw rfqVendorInvitationTokenInvalidError();
    if (
      invitation.status === 'REVOKED' ||
      invitation.status === 'DECLINED' ||
      invitation.status === 'NO_BID' ||
      invitation.status === 'QUOTATION_SUBMITTED'
    ) throw rfqVendorInvitationTokenInvalidError();
    if (invitation.tokenConsumedAt) throw rfqVendorInvitationTokenReplayedError();

    const rfq = await rfqRepository.findByIdForUpdate(client, invitation.rfqId);
    if (!rfq) throw rfqVendorInvitationTokenInvalidError();
    if (
      invitation.tokenExpiresAt.getTime() <= Date.now() ||
      invitation.responseDeadlineSnapshot.getTime() <= Date.now() ||
      rfq.status !== 'OPEN'
    ) {
      await expireInvitationIfNeeded(client, invitation, rfq.status !== 'OPEN' ? 'RFQ_NOT_OPEN' : 'TOKEN_DEADLINE');
      return { kind: 'EXPIRED' as const };
    }

    const viewedBefore = invitation.viewedAt !== null;
    if (!await rfqVendorInvitationRepository.consumeTokenWithClient(client, invitation.id)) {
      throw rfqVendorInvitationTokenReplayedError();
    }

    const issuedAt = new Date();
    const rawSessionToken = generateRfqVendorSessionToken();
    const session = await rfqVendorInvitationRepository.createSessionWithClient(client, {
      invitationId: invitation.id,
      rfqId: invitation.rfqId,
      vendorId: invitation.vendorId,
      clientId: invitation.clientId,
      buildingId: invitation.buildingId,
      sessionTokenHash: hashRfqVendorSessionToken(rawSessionToken),
      issuedAt,
      expiresAt: sessionExpiresAt(invitation, issuedAt),
    });

    const metadata = {
      rfqId: invitation.rfqId,
      vendorId: invitation.vendorId,
      invitationId: invitation.id,
      sessionId: session.id,
      actorType: 'VENDOR_RFQ_SESSION',
    };
    if (!viewedBefore) {
      await recordOperationalEvent(
        {
          clientId: invitation.clientId,
          buildingId: invitation.buildingId,
          eventType: 'RFQ_VENDOR_INVITATION_VIEWED',
          entityType: 'RFQ_VENDOR_INVITATION',
          entityId: invitation.id,
          actorUserId: null,
          summary: 'Vendor RFQ invitation viewed.',
          metadata,
        },
        client,
      );
    }
    await recordOperationalEvent(
      {
        clientId: invitation.clientId,
        buildingId: invitation.buildingId,
        eventType: 'RFQ_VENDOR_SESSION_ISSUED',
        entityType: 'RFQ_VENDOR_ACCESS_SESSION',
        entityId: session.id,
        actorUserId: null,
        summary: 'External Vendor RFQ session issued.',
        metadata,
      },
      client,
    );

    return {
      session: toPublicSession(session),
      sessionToken: rawSessionToken,
      access: {
        invitationId: invitation.id,
        rfqId: invitation.rfqId,
        vendorId: invitation.vendorId,
      },
    };
  });
  if ('kind' in result && result.kind === 'EXPIRED') {
    throw rfqVendorInvitationTokenExpiredError();
  }
  return result;
}

/** Resolves the external bearer session without using internal auth/RBAC. */
export async function resolveRfqVendorSession(
  rawToken: string,
): Promise<RfqVendorSessionContext> {
  const session = await rfqVendorInvitationRepository.findSessionByTokenHash(
    hashRfqVendorSessionToken(rawToken),
  );
  if (!session) throw rfqVendorSessionNotFoundError();
  if (session.status === 'REVOKED') throw rfqVendorSessionRevokedError();
  if (session.status === 'EXPIRED') throw rfqVendorSessionExpiredError();

  if (session.expiresAt.getTime() <= Date.now()) {
    await withTransaction(async (client) => {
      const locked = await rfqVendorInvitationRepository.findSessionByTokenHashForUpdate(
        client,
        hashRfqVendorSessionToken(rawToken),
      );
      if (!locked || locked.status !== 'ACTIVE') return;
      const expired = await rfqVendorInvitationRepository.markSessionExpiredWithClient(client, locked.id);
      if (!expired) return;
      await recordOperationalEvent(
        {
          clientId: expired.clientId,
          buildingId: expired.buildingId,
          eventType: 'RFQ_VENDOR_SESSION_EXPIRED',
          entityType: 'RFQ_VENDOR_ACCESS_SESSION',
          entityId: expired.id,
          actorUserId: null,
          summary: 'External Vendor RFQ session expired.',
          metadata: {
            rfqId: expired.rfqId,
            vendorId: expired.vendorId,
            invitationId: expired.invitationId,
            sessionId: expired.id,
            actorType: 'VENDOR_RFQ_SESSION',
          },
        },
        client,
      );
    });
    throw rfqVendorSessionExpiredError();
  }

  const invitation = await rfqVendorInvitationRepository.findById(session.invitationId);
  if (!invitation) throw rfqVendorSessionInvitationMismatchError();
  if (
    invitation.rfqId !== session.rfqId ||
    invitation.vendorId !== session.vendorId ||
    invitation.clientId !== session.clientId ||
    invitation.buildingId !== session.buildingId
  ) throw rfqVendorSessionInvitationMismatchError();
  if (invitation.status === 'REVOKED') throw rfqVendorSessionRevokedError();
  if (invitation.status === 'EXPIRED') throw rfqVendorSessionExpiredError();

  await rfqVendorInvitationRepository.touchSession(session.id);

  return {
    sessionId: session.id,
    invitationId: session.invitationId,
    rfqId: session.rfqId,
    vendorId: session.vendorId,
    clientId: session.clientId,
    buildingId: session.buildingId,
  };
}

async function resolveVendorSafeRfq(
  context: RfqVendorSessionContext,
): Promise<VendorSafeRfq> {
  const rfq = await rfqRepository.findById(context.rfqId);
  if (!rfq) throw rfqVendorSessionRfqMismatchError();
  if (
    rfq.clientId !== context.clientId ||
    rfq.buildingId !== context.buildingId
  ) throw rfqVendorSessionRfqMismatchError();
  const invitation = await rfqVendorInvitationRepository.findById(context.invitationId);
  if (!invitation) throw rfqVendorSessionInvitationMismatchError();
  if (invitation.vendorId !== context.vendorId) throw rfqVendorSessionInvitationMismatchError();
  const lines = await rfqRepository.listLines(context.rfqId);
  return {
    rfq: {
      id: rfq.id,
      rfqNumber: rfq.rfqNumber,
      title: rfq.title,
      description: rfq.description,
      sourceMode: rfq.sourceMode,
      currency: rfq.currency,
      requiredDate: rfq.requiredDate?.toISOString() ?? null,
      responseDeadline: rfq.responseDeadline?.toISOString() ?? null,
      status: rfq.status,
      lines: lines.map((line: RfqLineRecord) => ({
        id: line.id,
        lineNumber: line.lineNumber,
        sourceMode: line.sourceMode,
        description: line.sourceDescription,
        quantity: line.quantitySnapshot,
        requiredDate: line.sourceRequiredDate?.toISOString() ?? null,
      })),
    },
    invitation: {
      id: invitation.id,
      vendorId: invitation.vendorId,
      status: invitation.status,
      responseDeadline: invitation.responseDeadlineSnapshot.toISOString(),
      contactName: invitation.contactNameSnapshot,
    },
  };
}

export async function getVendorSafeRfq(
  context: RfqVendorSessionContext,
  rfqId: string,
): Promise<VendorSafeRfq> {
  if (context.rfqId !== rfqId) throw rfqVendorSessionRfqMismatchError();
  return resolveVendorSafeRfq(context);
}

export async function getVendorSafeInvitation(
  context: RfqVendorSessionContext,
  invitationId: string,
): Promise<VendorSafeRfq> {
  if (context.invitationId !== invitationId) throw rfqVendorSessionInvitationMismatchError();
  return resolveVendorSafeRfq(context);
}

async function actionWithSession(
  context: RfqVendorSessionContext,
  action: RfqVendorAction,
  reason: string | null,
): Promise<PublicRfqVendorInvitation> {
  const result = await withTransaction(async (client) => {
    const session = await rfqVendorInvitationRepository.findSessionByTokenHashForUpdate(
      client,
      // The session context only contains the UUID. Fetch by id through a
      // scoped query instead of accepting any caller-supplied invitation.
      await getSessionHashById(client, context.sessionId),
    );
    if (!session || session.id !== context.sessionId) throw rfqVendorSessionNotFoundError();
    if (session.status !== 'ACTIVE' || session.expiresAt.getTime() <= Date.now()) {
      throw session.status === 'REVOKED' ? rfqVendorSessionRevokedError() : rfqVendorSessionExpiredError();
    }
    const invitation = await rfqVendorInvitationRepository.findByIdForUpdate(client, context.invitationId);
    if (!invitation) throw rfqVendorSessionInvitationMismatchError();
    const rfq = await rfqRepository.findByIdForUpdate(client, context.rfqId);
    if (!rfq || rfq.clientId !== context.clientId || rfq.buildingId !== context.buildingId) {
      throw rfqVendorSessionRfqMismatchError();
    }
    if (invitation.vendorId !== context.vendorId || invitation.rfqId !== rfq.id) {
      throw rfqVendorSessionInvitationMismatchError();
    }
    if (
      rfq.status !== 'OPEN' ||
      invitation.responseDeadlineSnapshot.getTime() <= Date.now()
    ) {
      await expireInvitationIfNeeded(client, invitation, 'RFQ_NOT_OPEN_OR_DEADLINE');
      return { kind: 'EXPIRED' as const };
    }

    if (action === 'ACCEPT' && invitation.status === 'ACCEPTED') {
      return toPublicInvitation(invitation);
    }
    if (!(ACTIVE_INVITATION_STATUSES as readonly string[]).includes(invitation.status)) {
      throw rfqVendorInvitationActionNotAllowedError();
    }

    const target = action === 'ACCEPT' ? 'ACCEPTED' : action === 'DECLINE' ? 'DECLINED' : 'NO_BID';
    const updated = await rfqVendorInvitationRepository.markActionWithClient(
      client,
      invitation.id,
      target,
      reason,
    );
    if (!updated) throw rfqVendorInvitationActionNotAllowedError();
    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        buildingId: updated.buildingId,
        eventType: `RFQ_VENDOR_INVITATION_${target}`,
        entityType: 'RFQ_VENDOR_INVITATION',
        entityId: updated.id,
        actorUserId: null,
        summary: `Vendor RFQ invitation ${target.toLowerCase()}.`,
        metadata: {
          rfqId: updated.rfqId,
          vendorId: updated.vendorId,
          invitationId: updated.id,
          sessionId: context.sessionId,
          actorType: 'VENDOR_RFQ_SESSION',
          ...(reason ? { reason } : {}),
        },
      },
      client,
    );
    return toPublicInvitation(updated);
  });
  if (
    typeof result === 'object' &&
    result !== null &&
    'kind' in result &&
    result.kind === 'EXPIRED'
  ) {
    throw rfqVendorInvitationNotOpenError();
  }
  return result as PublicRfqVendorInvitation;
}

async function getSessionHashById(
  client: import('pg').PoolClient,
  sessionId: string,
): Promise<string> {
  const result = await client.query<{ sessionTokenHash: string }>(
    `SELECT session_token_hash AS "sessionTokenHash"
       FROM rfq_vendor_access_sessions
      WHERE id = $1`,
    [sessionId],
  );
  if (!result.rows[0]) throw rfqVendorSessionNotFoundError();
  return result.rows[0].sessionTokenHash;
}

export function acceptVendorRfqInvitation(
  context: RfqVendorSessionContext,
): Promise<PublicRfqVendorInvitation> {
  return actionWithSession(context, 'ACCEPT', null);
}

export function declineVendorRfqInvitation(
  context: RfqVendorSessionContext,
  reason?: string | null,
): Promise<PublicRfqVendorInvitation> {
  return actionWithSession(context, 'DECLINE', reason ?? null);
}

export function recordVendorRfqNoBid(
  context: RfqVendorSessionContext,
  reason?: string | null,
): Promise<PublicRfqVendorInvitation> {
  return actionWithSession(context, 'NO_BID', reason ?? null);
}

export const rfqVendorInvitationService = {
  acceptVendorRfqInvitation,
  createRfqVendorInvitation,
  declineVendorRfqInvitation,
  exchangeRfqVendorInvitationToken,
  getRfqVendorInvitation,
  getVendorSafeInvitation,
  getVendorSafeRfq,
  listAccessibleRfqVendorInvitations,
  listRfqVendorInvitations,
  recordVendorRfqNoBid,
  resolveRfqVendorSession,
  resendRfqVendorInvitation,
  revokeRfqVendorInvitation,
};
