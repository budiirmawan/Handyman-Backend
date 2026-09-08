import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type { CredentialRecord, UpdatePasswordInput } from './credential.types';

type CredentialRow = {
  id: string;
  userId: string;
  passwordHash: string;
  mustChangePassword: boolean;
  passwordChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const CREDENTIAL_SELECT = `
  id,
  user_id AS "userId",
  password_hash AS "passwordHash",
  must_change_password AS "mustChangePassword",
  password_changed_at AS "passwordChangedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapCredentialRow(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    userId: row.userId,
    passwordHash: row.passwordHash,
    mustChangePassword: row.mustChangePassword,
    passwordChangedAt: row.passwordChangedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createForUser(
  input: {
    userId: string;
    passwordHash: string;
    mustChangePassword: boolean;
  },
  client?: PoolClient,
): Promise<CredentialRecord> {
  const queryable = client ?? getPool();
  const result = await queryable.query<CredentialRow>(
    `INSERT INTO user_credentials (id, user_id, password_hash, must_change_password)
     VALUES ($1, $2, $3, $4)
     RETURNING ${CREDENTIAL_SELECT}`,
    [randomUUID(), input.userId, input.passwordHash, input.mustChangePassword],
  );

  return mapCredentialRow(result.rows[0]);
}

async function findByUserId(userId: string): Promise<CredentialRecord | null> {
  const result = await getPool().query<CredentialRow>(
    `SELECT ${CREDENTIAL_SELECT} FROM user_credentials WHERE user_id = $1`,
    [userId],
  );

  const row = result.rows[0];
  return row ? mapCredentialRow(row) : null;
}

async function updatePassword(
  userId: string,
  input: UpdatePasswordInput,
): Promise<CredentialRecord | null> {
  const result = await getPool().query<CredentialRow>(
    `UPDATE user_credentials
     SET password_hash = $2, password_changed_at = $3, updated_at = NOW()
     WHERE user_id = $1
     RETURNING ${CREDENTIAL_SELECT}`,
    [userId, input.passwordHash, input.passwordChangedAt],
  );

  const row = result.rows[0];
  return row ? mapCredentialRow(row) : null;
}

export const credentialRepository = {
  createForUser,
  findByUserId,
  updatePassword,
};
