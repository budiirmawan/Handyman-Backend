import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateSecurityKeyInput,
  SecurityKeyCustodyRecord,
  SecurityKeyCustodyTransactionType,
  SecurityKeyListFilters,
  SecurityKeyRecord,
  SecurityKeyStatus,
  UpdateSecurityKeyInput,
} from './security-key.types';

/**
 * BE-12K — Security Key Control repository.
 *
 * Holds the Key master row and the append-oriented custody history.
 * The Key's `status` is updated in place as custody transactions
 * occur; custody rows are NEVER updated or deleted — they are
 * append-only historical records.
 */

type SecurityKeyRow = {
  id: string;
  client_id: string;
  building_id: string;
  code: string;
  name: string;
  description: string | null;
  security_post_id: string | null;
  functional_location_id: string | null;
  status: SecurityKeyStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const SECURITY_KEY_COLUMNS = `
  id, client_id, building_id, code, name, description, security_post_id,
  functional_location_id, status, created_by_user_id, created_at, updated_at
`;

function mapKeyRow(row: SecurityKeyRow): SecurityKeyRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    code: row.code,
    name: row.name,
    description: row.description,
    securityPostId: row.security_post_id,
    functionalLocationId: row.functional_location_id,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type SecurityKeyCustodyRow = {
  id: string;
  key_id: string;
  transaction_type: SecurityKeyCustodyTransactionType;
  issued_to_workforce_id: string | null;
  issued_by_user_id: string | null;
  issued_at: Date | null;
  expected_return_at: Date | null;
  returned_at: Date | null;
  returned_to_user_id: string | null;
  notes: string | null;
  created_at: Date;
};

const SECURITY_KEY_CUSTODY_COLUMNS = `
  id, key_id, transaction_type, issued_to_workforce_id, issued_by_user_id,
  issued_at, expected_return_at, returned_at, returned_to_user_id, notes,
  created_at
`;

function mapCustodyRow(
  row: SecurityKeyCustodyRow,
): SecurityKeyCustodyRecord {
  return {
    id: row.id,
    keyId: row.key_id,
    transactionType: row.transaction_type,
    issuedToWorkforceId: row.issued_to_workforce_id,
    issuedByUserId: row.issued_by_user_id,
    issuedAt: row.issued_at,
    expectedReturnAt: row.expected_return_at,
    returnedAt: row.returned_at,
    returnedToUserId: row.returned_to_user_id,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ */
/*  Key master CRUD                                                     */
/* ------------------------------------------------------------------ */

export async function create(
  input: CreateSecurityKeyInput & { clientId: string },
): Promise<SecurityKeyRecord> {
  const result = await getPool().query<SecurityKeyRow>(
    `INSERT INTO security_keys
       (id, client_id, building_id, code, name, description,
        security_post_id, functional_location_id, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${SECURITY_KEY_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.code,
      input.name,
      input.description ?? null,
      input.securityPostId ?? null,
      input.functionalLocationId ?? null,
      input.status ?? 'AVAILABLE',
      input.createdByUserId,
    ],
  );
  return mapKeyRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<SecurityKeyRecord | null> {
  const result = await getPool().query<SecurityKeyRow>(
    `SELECT ${SECURITY_KEY_COLUMNS}
     FROM security_keys WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapKeyRow(result.rows[0]) : null;
}

export async function findByBuildingAndCode(
  buildingId: string,
  code: string,
): Promise<SecurityKeyRecord | null> {
  const result = await getPool().query<SecurityKeyRow>(
    `SELECT ${SECURITY_KEY_COLUMNS}
     FROM security_keys WHERE building_id = $1 AND code = $2`,
    [buildingId, code],
  );
  return result.rows[0] ? mapKeyRow(result.rows[0]) : null;
}

export async function list(
  filter: SecurityKeyListFilters = {},
): Promise<SecurityKeyRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.buildingId) {
    values.push(filter.buildingId);
    conditions.push(`building_id = $${values.length}`);
  }
  if (filter.securityPostId) {
    values.push(filter.securityPostId);
    conditions.push(`security_post_id = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<SecurityKeyRow>(
    `SELECT ${SECURITY_KEY_COLUMNS}
     FROM security_keys
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY code ASC`,
    values,
  );
  return result.rows.map(mapKeyRow);
}

export async function listByBuildingIds(
  buildingIds: string[],
  filter: SecurityKeyListFilters = {},
): Promise<SecurityKeyRecord[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const conditions = [`building_id = ANY($1::uuid[])`];
  const values: unknown[] = [buildingIds];

  if (filter.securityPostId) {
    values.push(filter.securityPostId);
    conditions.push(`security_post_id = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<SecurityKeyRow>(
    `SELECT ${SECURITY_KEY_COLUMNS}
     FROM security_keys
     WHERE ${conditions.join(' AND ')}
     ORDER BY code ASC`,
    values,
  );
  return result.rows.map(mapKeyRow);
}

export async function update(
  id: string,
  input: UpdateSecurityKeyInput,
): Promise<SecurityKeyRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.securityPostId !== undefined) {
    values.push(input.securityPostId);
    sets.push(`security_post_id = $${values.length}`);
  }
  if (input.functionalLocationId !== undefined) {
    values.push(input.functionalLocationId);
    sets.push(`functional_location_id = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<SecurityKeyRow>(
    `UPDATE security_keys
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${SECURITY_KEY_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapKeyRow(result.rows[0]) : null;
}

/* ------------------------------------------------------------------ */
/*  Custody                                                            */
/* ------------------------------------------------------------------ */

export async function insertCustody(
  input: {
    keyId: string;
    transactionType: SecurityKeyCustodyTransactionType;
    issuedToWorkforceId: string | null;
    issuedByUserId: string | null;
    issuedAt: Date | null;
    expectedReturnAt: Date | null;
    returnedAt: Date | null;
    returnedToUserId: string | null;
    notes: string | null;
  },
): Promise<SecurityKeyCustodyRecord> {
  const result = await getPool().query<SecurityKeyCustodyRow>(
    `INSERT INTO security_key_custody
       (id, key_id, transaction_type, issued_to_workforce_id,
        issued_by_user_id, issued_at, expected_return_at, returned_at,
        returned_to_user_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${SECURITY_KEY_CUSTODY_COLUMNS}`,
    [
      randomUUID(),
      input.keyId,
      input.transactionType,
      input.issuedToWorkforceId,
      input.issuedByUserId,
      input.issuedAt,
      input.expectedReturnAt,
      input.returnedAt,
      input.returnedToUserId,
      input.notes,
    ],
  );
  return mapCustodyRow(result.rows[0]);
}

export async function findCustodyById(
  id: string,
): Promise<SecurityKeyCustodyRecord | null> {
  const result = await getPool().query<SecurityKeyCustodyRow>(
    `SELECT ${SECURITY_KEY_CUSTODY_COLUMNS}
     FROM security_key_custody WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapCustodyRow(result.rows[0]) : null;
}

/**
 * Closes an open ISSUE custody row with the return timestamp and
 * the user that received the key. The historical columns
 * (issued_to, issued_by, issued_at, expected_return_at) are NEVER
 * modified — only the return-side fields are added.
 */
export async function closeIssueCustody(
  id: string,
  returnedAt: Date,
  returnedToUserId: string,
): Promise<SecurityKeyCustodyRecord | null> {
  const result = await getPool().query<SecurityKeyCustodyRow>(
    `UPDATE security_key_custody
     SET returned_at = $2, returned_to_user_id = $3
     WHERE id = $1
       AND transaction_type = 'ISSUE'
       AND returned_at IS NULL
     RETURNING ${SECURITY_KEY_CUSTODY_COLUMNS}`,
    [id, returnedAt, returnedToUserId],
  );
  return result.rows[0] ? mapCustodyRow(result.rows[0]) : null;
}

export async function findOpenIssueForKey(
  keyId: string,
): Promise<SecurityKeyCustodyRecord | null> {
  const result = await getPool().query<SecurityKeyCustodyRow>(
    `SELECT ${SECURITY_KEY_CUSTODY_COLUMNS}
     FROM security_key_custody
     WHERE key_id = $1
       AND transaction_type = 'ISSUE'
       AND returned_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [keyId],
  );
  return result.rows[0] ? mapCustodyRow(result.rows[0]) : null;
}

export async function listCustodyHistory(
  keyId: string,
): Promise<SecurityKeyCustodyRecord[]> {
  const result = await getPool().query<SecurityKeyCustodyRow>(
    `SELECT ${SECURITY_KEY_CUSTODY_COLUMNS}
     FROM security_key_custody
     WHERE key_id = $1
     ORDER BY created_at ASC, id ASC`,
    [keyId],
  );
  return result.rows.map(mapCustodyRow);
}

export const securityKeyRepository = {
  closeIssueCustody,
  create,
  findByBuildingAndCode,
  findById,
  findCustodyById,
  findOpenIssueForKey,
  insertCustody,
  list,
  listByBuildingIds,
  listCustodyHistory,
  update,
};
