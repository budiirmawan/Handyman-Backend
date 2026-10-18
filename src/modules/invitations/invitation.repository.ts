import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  InvitationListStatus,
  InvitationRecord,
  InvitationStatus,
} from './invitation.types';

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

async function createInvitation(
  input: {
    email: string;
    tokenHash: string;
    expiresAt: Date;
    invitedByUserId: string;
  },
  client?: PoolClient,
): Promise<InvitationRecord> {
  const queryable = client ?? getPool();
  const result = await queryable.query<InvitationRow>(
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
  client?: PoolClient,
): Promise<InvitationRecord | null> {
  const queryable = client ?? getPool();
  const result = await queryable.query<InvitationRow>(
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

async function findByIdForUpdate(
  client: PoolClient,
  id: string,
): Promise<InvitationRecord | null> {
  const result = await client.query<InvitationRow>(
    `SELECT ${INVITATION_SELECT} FROM user_invitations WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapInvitationRow(row) : null;
}

async function markRevoked(
  client: PoolClient,
  id: string,
  revokedAt: Date,
): Promise<InvitationRecord | null> {
  const result = await client.query<InvitationRow>(
    `UPDATE user_invitations
     SET status = 'REVOKED', revoked_at = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'PENDING'
     RETURNING ${INVITATION_SELECT}`,
    [id, revokedAt],
  );

  const row = result.rows[0];
  return row ? mapInvitationRow(row) : null;
}

type InvitationListFilters = {
  email?: string;
  status?: InvitationListStatus;
  limit: number;
  offset: number;
};

async function listInvitations(
  filters: InvitationListFilters,
): Promise<{ rows: InvitationRecord[]; total: number }> {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters.email) {
    params.push(filters.email.toLowerCase());
    where.push(`email = $${params.length}`);
  }
  if (filters.status === 'EXPIRED') {
    where.push(`status = 'PENDING' AND expires_at <= NOW()`);
  } else if (filters.status === 'PENDING') {
    where.push(`status = 'PENDING' AND expires_at > NOW()`);
  } else if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const countResult = await getPool().query<{ total: string }>(
    `SELECT COUNT(*)::int AS total FROM user_invitations ${whereClause}`,
    params,
  );

  params.push(filters.limit, filters.offset);
  const result = await getPool().query<InvitationRow>(
    `SELECT ${INVITATION_SELECT}
     FROM user_invitations
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    rows: result.rows.map(mapInvitationRow),
    total: Number(countResult.rows[0]?.total ?? 0),
  };
}

async function findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
  const result = await getPool().query<InvitationRow>(
    `SELECT ${INVITATION_SELECT} FROM user_invitations WHERE token_hash = $1`,
    [tokenHash],
  );

  const row = result.rows[0];
  return row ? mapInvitationRow(row) : null;
}

export const invitationRepository = {
  createInvitation,
  findById,
  findByIdForUpdate,
  findByTokenHash,
  findByTokenHashForUpdate,
  findPendingValidByEmail,
  listInvitations,
  markAccepted,
  markRevoked,
};
