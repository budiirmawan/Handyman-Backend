import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  RfqVendorAccessSessionRecord,
  RfqVendorInvitationRecord,
  RfqVendorInvitationFilters,
  RfqVendorInvitationStatus,
} from './rfq-vendor-invitation.types';

type InvitationRow = {
  id: string;
  rfqId: string;
  vendorId: string;
  clientId: string;
  buildingId: string;
  attemptNumber: number;
  status: RfqVendorInvitationStatus;
  responseDeadlineSnapshot: Date;
  tokenHash: string;
  tokenExpiresAt: Date;
  tokenConsumedAt: Date | null;
  contactSourceType: 'VENDOR';
  contactSourceId: string;
  contactNameSnapshot: string;
  recipientEmailSnapshot: string | null;
  viewedAt: Date | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  noBidAt: Date | null;
  expiredAt: Date | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  responseReason: string | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

type SessionRow = {
  id: string;
  invitationId: string;
  rfqId: string;
  vendorId: string;
  clientId: string;
  buildingId: string;
  sessionTokenHash: string;
  status: RfqVendorAccessSessionRecord['status'];
  issuedAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  expiredAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const INVITATION_SELECT = `
  id,
  rfq_id AS "rfqId",
  vendor_id AS "vendorId",
  client_id AS "clientId",
  building_id AS "buildingId",
  attempt_number AS "attemptNumber",
  status,
  response_deadline_snapshot AS "responseDeadlineSnapshot",
  token_hash AS "tokenHash",
  token_expires_at AS "tokenExpiresAt",
  token_consumed_at AS "tokenConsumedAt",
  contact_source_type AS "contactSourceType",
  contact_source_id AS "contactSourceId",
  contact_name_snapshot AS "contactNameSnapshot",
  recipient_email_snapshot AS "recipientEmailSnapshot",
  viewed_at AS "viewedAt",
  accepted_at AS "acceptedAt",
  declined_at AS "declinedAt",
  no_bid_at AS "noBidAt",
  expired_at AS "expiredAt",
  revoked_at AS "revokedAt",
  revoked_by_user_id AS "revokedByUserId",
  response_reason AS "responseReason",
  idempotency_key AS "idempotencyKey",
  idempotency_fingerprint AS "idempotencyFingerprint",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`.trim();

const SESSION_SELECT = `
  id,
  invitation_id AS "invitationId",
  rfq_id AS "rfqId",
  vendor_id AS "vendorId",
  client_id AS "clientId",
  building_id AS "buildingId",
  session_token_hash AS "sessionTokenHash",
  status,
  issued_at AS "issuedAt",
  expires_at AS "expiresAt",
  last_used_at AS "lastUsedAt",
  expired_at AS "expiredAt",
  revoked_at AS "revokedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`.trim();

function mapInvitation(row: InvitationRow): RfqVendorInvitationRecord {
  return row;
}

function mapSession(row: SessionRow): RfqVendorAccessSessionRecord {
  return row;
}

async function findById(id: string): Promise<RfqVendorInvitationRecord | null> {
  const result = await getPool().query<InvitationRow>(
    `SELECT ${INVITATION_SELECT} FROM rfq_vendor_invitations WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapInvitation(result.rows[0]) : null;
}

async function findByIdForUpdate(
  client: PoolClient,
  id: string,
): Promise<RfqVendorInvitationRecord | null> {
  const result = await client.query<InvitationRow>(
    `SELECT ${INVITATION_SELECT}
       FROM rfq_vendor_invitations
      WHERE id = $1
      FOR UPDATE`,
    [id],
  );
  return result.rows[0] ? mapInvitation(result.rows[0]) : null;
}

async function findByTokenHashForUpdate(
  client: PoolClient,
  tokenHash: string,
): Promise<RfqVendorInvitationRecord | null> {
  const result = await client.query<InvitationRow>(
    `SELECT ${INVITATION_SELECT}
       FROM rfq_vendor_invitations
      WHERE token_hash = $1
      FOR UPDATE`,
    [tokenHash],
  );
  return result.rows[0] ? mapInvitation(result.rows[0]) : null;
}

async function findByIdempotencyKeyForUpdate(
  client: PoolClient,
  clientId: string,
  idempotencyKey: string,
): Promise<RfqVendorInvitationRecord | null> {
  const result = await client.query<InvitationRow>(
    `SELECT ${INVITATION_SELECT}
       FROM rfq_vendor_invitations
      WHERE client_id = $1 AND idempotency_key = $2
      FOR UPDATE`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ? mapInvitation(result.rows[0]) : null;
}

async function findActiveByRfqAndVendor(
  client: PoolClient,
  rfqId: string,
  vendorId: string,
): Promise<RfqVendorInvitationRecord | null> {
  const result = await client.query<InvitationRow>(
    `SELECT ${INVITATION_SELECT}
       FROM rfq_vendor_invitations
      WHERE rfq_id = $1
        AND vendor_id = $2
        AND status IN ('INVITED', 'ACCEPTED', 'QUOTATION_SUBMITTED')
      ORDER BY attempt_number DESC
      LIMIT 1
      FOR UPDATE`,
    [rfqId, vendorId],
  );
  return result.rows[0] ? mapInvitation(result.rows[0]) : null;
}

async function nextAttemptNumber(
  client: PoolClient,
  rfqId: string,
  vendorId: string,
): Promise<number> {
  const result = await client.query<{ nextAttempt: number }>(
    `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS "nextAttempt"
       FROM rfq_vendor_invitations
      WHERE rfq_id = $1 AND vendor_id = $2`,
    [rfqId, vendorId],
  );
  return Number(result.rows[0]?.nextAttempt ?? 1);
}

async function createIdempotent(
  client: PoolClient,
  input: {
    rfqId: string;
    vendorId: string;
    clientId: string;
    buildingId: string;
    attemptNumber: number;
    responseDeadlineSnapshot: Date;
    tokenHash: string;
    tokenExpiresAt: Date;
    contactNameSnapshot: string;
    recipientEmailSnapshot: string | null;
    idempotencyKey: string;
    idempotencyFingerprint: string;
    createdByUserId: string;
  },
): Promise<{ record: RfqVendorInvitationRecord; created: boolean }> {
  const result = await client.query<InvitationRow>(
    `INSERT INTO rfq_vendor_invitations
       (id, rfq_id, vendor_id, client_id, building_id, attempt_number,
        response_deadline_snapshot, token_hash, token_expires_at,
        contact_source_type, contact_source_id, contact_name_snapshot,
        recipient_email_snapshot, idempotency_key, idempotency_fingerprint,
        created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'VENDOR',$3,$10,$11,$12,$13,$14)
     ON CONFLICT (client_id, idempotency_key) DO NOTHING
     RETURNING ${INVITATION_SELECT}`,
    [
      randomUUID(),
      input.rfqId,
      input.vendorId,
      input.clientId,
      input.buildingId,
      input.attemptNumber,
      input.responseDeadlineSnapshot,
      input.tokenHash,
      input.tokenExpiresAt,
      input.contactNameSnapshot,
      input.recipientEmailSnapshot,
      input.idempotencyKey,
      input.idempotencyFingerprint,
      input.createdByUserId,
    ],
  );

  if (result.rows[0]) {
    return { record: mapInvitation(result.rows[0]), created: true };
  }

  const existing = await findByIdempotencyKeyForUpdate(
    client,
    input.clientId,
    input.idempotencyKey,
  );
  if (!existing) {
    throw new Error('RFQ Vendor invitation idempotency conflict could not be resolved.');
  }
  return { record: existing, created: false };
}

async function listByRfq(
  rfqId: string,
  filters: RfqVendorInvitationFilters,
): Promise<RfqVendorInvitationRecord[]> {
  const values: unknown[] = [rfqId];
  const conditions = ['rfq_id = $1'];
  if (filters.vendorId !== undefined) {
    values.push(filters.vendorId);
    conditions.push(`vendor_id = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  const result = await getPool().query<InvitationRow>(
    `SELECT ${INVITATION_SELECT} FROM rfq_vendor_invitations
      WHERE ${conditions.join(' AND ')}
      ORDER BY attempt_number DESC, created_at DESC`,
    values,
  );
  return result.rows.map(mapInvitation);
}

async function listByBuilding(
  buildingIds: string[],
  filters: RfqVendorInvitationFilters,
): Promise<RfqVendorInvitationRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [buildingIds];
  const conditions = ['building_id = ANY($1::uuid[])'];
  if (filters.vendorId !== undefined) {
    values.push(filters.vendorId);
    conditions.push(`vendor_id = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  const result = await getPool().query<InvitationRow>(
    `SELECT ${INVITATION_SELECT} FROM rfq_vendor_invitations
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, id DESC`,
    values,
  );
  return result.rows.map(mapInvitation);
}

async function markRevokedWithClient(
  client: PoolClient,
  id: string,
  actorUserId: string,
): Promise<RfqVendorInvitationRecord | null> {
  const result = await client.query<InvitationRow>(
    `UPDATE rfq_vendor_invitations
        SET status = 'REVOKED', revoked_at = NOW(), revoked_by_user_id = $2,
            updated_at = NOW()
      WHERE id = $1 AND status <> 'REVOKED'
      RETURNING ${INVITATION_SELECT}`,
    [id, actorUserId],
  );
  return result.rows[0] ? mapInvitation(result.rows[0]) : null;
}

async function markExpiredWithClient(
  client: PoolClient,
  id: string,
): Promise<RfqVendorInvitationRecord | null> {
  const result = await client.query<InvitationRow>(
    `UPDATE rfq_vendor_invitations
        SET status = 'EXPIRED', expired_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status IN ('INVITED', 'ACCEPTED')
      RETURNING ${INVITATION_SELECT}`,
    [id],
  );
  return result.rows[0] ? mapInvitation(result.rows[0]) : null;
}

async function markViewedWithClient(
  client: PoolClient,
  id: string,
): Promise<void> {
  await client.query(
    `UPDATE rfq_vendor_invitations
        SET viewed_at = COALESCE(viewed_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND viewed_at IS NULL`,
    [id],
  );
}

async function consumeTokenWithClient(
  client: PoolClient,
  id: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE rfq_vendor_invitations
        SET token_consumed_at = NOW(),
            viewed_at = COALESCE(viewed_at, NOW()),
            updated_at = NOW()
      WHERE id = $1 AND token_consumed_at IS NULL
        AND status IN ('INVITED', 'ACCEPTED')
      RETURNING id`,
    [id],
  );
  return (result.rowCount ?? 0) === 1;
}

async function markQuotationSubmittedWithClient(
  client: PoolClient,
  id: string,
): Promise<void> {
  await client.query(
    `UPDATE rfq_vendor_invitations
        SET status = 'QUOTATION_SUBMITTED', updated_at = NOW()
      WHERE id = $1 AND status IN ('INVITED', 'ACCEPTED', 'QUOTATION_SUBMITTED')`,
    [id],
  );
}

async function markActionWithClient(
  client: PoolClient,
  id: string,
  action: 'ACCEPTED' | 'DECLINED' | 'NO_BID',
  reason: string | null,
): Promise<RfqVendorInvitationRecord | null> {
  const field = action === 'ACCEPTED'
    ? 'accepted_at'
    : action === 'DECLINED'
      ? 'declined_at'
      : 'no_bid_at';
  const result = await client.query<InvitationRow>(
    `UPDATE rfq_vendor_invitations
        SET status = $2, ${field} = NOW(), response_reason = $3,
            updated_at = NOW()
      WHERE id = $1 AND status IN ('INVITED', 'ACCEPTED')
      RETURNING ${INVITATION_SELECT}`,
    [id, action, reason],
  );
  return result.rows[0] ? mapInvitation(result.rows[0]) : null;
}

async function findSessionByTokenHashForUpdate(
  client: PoolClient,
  tokenHash: string,
): Promise<RfqVendorAccessSessionRecord | null> {
  const result = await client.query<SessionRow>(
    `SELECT ${SESSION_SELECT}
       FROM rfq_vendor_access_sessions
      WHERE session_token_hash = $1
      FOR UPDATE`,
    [tokenHash],
  );
  return result.rows[0] ? mapSession(result.rows[0]) : null;
}

async function findSessionByTokenHash(
  tokenHash: string,
): Promise<RfqVendorAccessSessionRecord | null> {
  const result = await getPool().query<SessionRow>(
    `SELECT ${SESSION_SELECT}
       FROM rfq_vendor_access_sessions
      WHERE session_token_hash = $1`,
    [tokenHash],
  );
  return result.rows[0] ? mapSession(result.rows[0]) : null;
}

async function createSessionWithClient(
  client: PoolClient,
  input: {
    invitationId: string;
    rfqId: string;
    vendorId: string;
    clientId: string;
    buildingId: string;
    sessionTokenHash: string;
    issuedAt: Date;
    expiresAt: Date;
  },
): Promise<RfqVendorAccessSessionRecord> {
  const result = await client.query<SessionRow>(
    `INSERT INTO rfq_vendor_access_sessions
       (id, invitation_id, rfq_id, vendor_id, client_id, building_id,
        session_token_hash, issued_at, expires_at, last_used_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8)
     RETURNING ${SESSION_SELECT}`,
    [
      randomUUID(),
      input.invitationId,
      input.rfqId,
      input.vendorId,
      input.clientId,
      input.buildingId,
      input.sessionTokenHash,
      input.issuedAt,
      input.expiresAt,
    ],
  );
  return mapSession(result.rows[0]);
}

async function revokeActiveSessionsWithClient(
  client: PoolClient,
  invitationId: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE rfq_vendor_access_sessions
        SET status = 'REVOKED', revoked_at = NOW(), updated_at = NOW()
      WHERE invitation_id = $1 AND status = 'ACTIVE'`,
    [invitationId],
  );
  return result.rowCount ?? 0;
}

async function markSessionExpiredWithClient(
  client: PoolClient,
  id: string,
): Promise<RfqVendorAccessSessionRecord | null> {
  const result = await client.query<SessionRow>(
    `UPDATE rfq_vendor_access_sessions
        SET status = 'EXPIRED', expired_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${SESSION_SELECT}`,
    [id],
  );
  return result.rows[0] ? mapSession(result.rows[0]) : null;
}

async function markSessionRevokedWithClient(
  client: PoolClient,
  id: string,
): Promise<RfqVendorAccessSessionRecord | null> {
  const result = await client.query<SessionRow>(
    `UPDATE rfq_vendor_access_sessions
        SET status = 'REVOKED', revoked_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${SESSION_SELECT}`,
    [id],
  );
  return result.rows[0] ? mapSession(result.rows[0]) : null;
}

async function touchSessionWithClient(
  client: PoolClient,
  id: string,
): Promise<void> {
  await client.query(
    `UPDATE rfq_vendor_access_sessions
        SET last_used_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'`,
    [id],
  );
}

async function touchSession(id: string): Promise<void> {
  await getPool().query(
    `UPDATE rfq_vendor_access_sessions
        SET last_used_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'`,
    [id],
  );
}

export const rfqVendorInvitationRepository = {
  consumeTokenWithClient,
  createIdempotent,
  createSessionWithClient,
  findActiveByRfqAndVendor,
  findById,
  findByIdForUpdate,
  findByIdempotencyKeyForUpdate,
  findByTokenHashForUpdate,
  findSessionByTokenHash,
  findSessionByTokenHashForUpdate,
  listByBuilding,
  listByRfq,
  markActionWithClient,
  markExpiredWithClient,
  markQuotationSubmittedWithClient,
  markRevokedWithClient,
  markSessionExpiredWithClient,
  markSessionRevokedWithClient,
  markViewedWithClient,
  nextAttemptNumber,
  revokeActiveSessionsWithClient,
  touchSession,
  touchSessionWithClient,
};
