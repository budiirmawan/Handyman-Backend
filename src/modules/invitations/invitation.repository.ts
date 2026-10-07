import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type { InvitationRecord, InvitationStatus } from './invitation.types';

type InvitationRow = {
  id: string;
  email: string;
  tokenHash: string;
  status: InvitationStatus;
  expiresAt: Date;
  invitedByUserId: string | null;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const INVITATION_SELECT = `
  id,
  email,
  token_hash AS "tokenHash",
  status,
  expires_at AS "expiresAt",
  invited_by_user_id AS "invitedByUserId",
  accepted_by_user_id AS "acceptedByUserId",
  accepted_at AS "acceptedAt",
  revoked_at AS "revokedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapInvitationRow(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    email: row.email,
    tokenHash: row.tokenHash,
    status: row.status,
    expiresAt: row.expiresAt,
    invitedByUserId: row.invitedByUserId,
    acceptedByUserId: row.acceptedByUserId,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createInvitation(input: {
  email: string;
  tokenHash: string;
  expiresAt: Date;
  invitedByUserId: string;
}): Promise<InvitationRecord> {
  const result = await getPool().query<InvitationRow>(
    `INSERT INTO user_invitations (id, email, token_hash, expires_at, invited_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${INVITATION_SELECT}`,
    [randomUUID(), input.email, input.tokenHash, input.expiresAt, input.invitedByUserId],
  );

  return mapInvitationRow(result.rows[0]);
}

async function findById(id: string): Promise<InvitationRecord | null> {
  const result = await getPool().query<InvitationRow>(
    `SELECT ${INVITATION_SELECT} FROM user_invitations WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapInvitationRow(row) : null;
}

/** Locks the invitation row for the acceptance transaction. */
async function findByTokenHashForUpdate(
  client: PoolClient,
  tokenHash: string,
): Promise<InvitationRecord | null> {
  const result = await client.query<InvitationRow>(
    `SELECT ${INVITATION_SELECT} FROM user_invitations WHERE token_hash = $1 FOR UPDATE`,
    [tokenHash],
  );

  const row = result.rows[0];
  return row ? mapInvitationRow(row) : null;
}

async function findPendingValidByEmail(
  email: string,
  now: Date,
): Promise<InvitationRecord | null> {
  const result = await getPool().query<InvitationRow>(
    `SELECT ${INVITATION_SELECT} FROM user_invitations
     WHERE email = $1 AND status = 'PENDING' AND expires_at > $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [email, now],
  );

  const row = result.rows[0];
  return row ? mapInvitationRow(row) : null;
}

async function markAccepted(
  client: PoolClient,
  id: string,
  acceptedByUserId: string,
  acceptedAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE user_invitations
     SET status = 'ACCEPTED', accepted_by_user_id = $2, accepted_at = $3, updated_at = NOW()
     WHERE id = $1`,
    [id, acceptedByUserId, acceptedAt],
  );
}

async function markRevoked(
  id: string,
  revokedAt: Date,
): Promise<InvitationRecord | null> {
  const result = await getPool().query<InvitationRow>(
    `UPDATE user_invitations
     SET status = 'REVOKED', revoked_at = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${INVITATION_SELECT}`,
    [id, revokedAt],
  );

  const row = result.rows[0];
  return row ? mapInvitationRow(row) : null;
}

export const invitationRepository = {
  createInvitation,
  findById,
  findByTokenHashForUpdate,
  findPendingValidByEmail,
  markAccepted,
  markRevoked,
};
