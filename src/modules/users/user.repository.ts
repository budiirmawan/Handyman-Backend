import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type { NewUser, UserRecord, UserStatus } from './user.types';

type UserRow = {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  whatsappPhone: string | null;
  whatsappOptedInAt: Date | null;
  whatsappOptedOutAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const USER_SELECT = `
  id,
  email,
  display_name AS "displayName",
  status,
  whatsapp_phone AS "whatsappPhone",
  whatsapp_opted_in_at AS "whatsappOptedInAt",
  whatsapp_opted_out_at AS "whatsappOptedOutAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapUserRow(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    whatsappPhone: row.whatsappPhone,
    whatsappOptedInAt: row.whatsappOptedInAt,
    whatsappOptedOutAt: row.whatsappOptedOutAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createUser(
  input: NewUser,
  client?: PoolClient,
): Promise<UserRecord> {
  const queryable = client ?? getPool();
  const result = await queryable.query<UserRow>(
    `INSERT INTO users (id, email, display_name, status)
     VALUES ($1, $2, $3, $4)
     RETURNING ${USER_SELECT}`,
    [randomUUID(), input.email, input.displayName, input.status],
  );

  return mapUserRow(result.rows[0]);
}

async function findById(id: string): Promise<UserRecord | null> {
  const result = await getPool().query<UserRow>(
    `SELECT ${USER_SELECT} FROM users WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapUserRow(row) : null;
}

async function findByEmail(
  email: string,
  client?: PoolClient,
): Promise<UserRecord | null> {
  const queryable = client ?? getPool();
  const result = await queryable.query<UserRow>(
    `SELECT ${USER_SELECT} FROM users WHERE email = $1`,
    [email],
  );

  const row = result.rows[0];
  return row ? mapUserRow(row) : null;
}

async function updateStatus(
  id: string,
  status: UserStatus,
): Promise<UserRecord | null> {
  const result = await getPool().query<UserRow>(
    `UPDATE users SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${USER_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapUserRow(row) : null;
}

/**
 * CR-BE-NOTIFY-PROV-01 PART 06 — writes the WhatsApp contact + consent
 * columns in one statement. All three values are absolute (the service seam
 * computes them from the current row + requested change); unique-phone
 * conflicts surface as the partial unique index violation.
 */
async function updateWhatsAppContact(
  id: string,
  values: {
    whatsappPhone: string | null;
    whatsappOptedInAt: Date | null;
    whatsappOptedOutAt: Date | null;
  },
): Promise<UserRecord | null> {
  const result = await getPool().query<UserRow>(
    `UPDATE users
        SET whatsapp_phone = $2,
            whatsapp_opted_in_at = $3,
            whatsapp_opted_out_at = $4,
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${USER_SELECT}`,
    [id, values.whatsappPhone, values.whatsappOptedInAt, values.whatsappOptedOutAt],
  );

  const row = result.rows[0];
  return row ? mapUserRow(row) : null;
}

export const userRepository = {
  createUser,
  findById,
  findByEmail,
  updateStatus,
  updateWhatsAppContact,
};
