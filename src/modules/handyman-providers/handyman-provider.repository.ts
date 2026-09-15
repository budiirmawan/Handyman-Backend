import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanProviderFilters,
  HandymanProviderRecord,
  HandymanProviderStatus,
  NewHandymanProvider,
} from './handyman-provider.types';

/**
 * CR-HM-BE-02 RUN 1 — Handyman Provider designation persistence.
 *
 * Follows the CR-HM-BE-01 repository idiom: aliased SELECT projection, an
 * injectable executor (defaults to the shared pool) so callers can compose
 * inside a transaction, and guarded status transitions so concurrent
 * lifecycle commands cannot both succeed.
 *
 * The one-ACTIVE-per-(client, vendor) rule is structurally enforced by the
 * partial unique index `handyman_providers_one_active_per_client_vendor`
 * (migration 0349); the service translates its violation into the
 * domain-level 409.
 */

const HANDYMAN_PROVIDER_SELECT = `
  id,
  client_id AS "clientId",
  vendor_id AS "vendorId",
  status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function findById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanProviderRecord | null> {
  const result = await executor.query<HandymanProviderRecord>(
    `SELECT ${HANDYMAN_PROVIDER_SELECT}
     FROM handyman_providers
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveByClientAndVendor(
  clientId: string,
  vendorId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanProviderRecord | null> {
  const result = await executor.query<HandymanProviderRecord>(
    `SELECT ${HANDYMAN_PROVIDER_SELECT}
     FROM handyman_providers
     WHERE client_id = $1 AND vendor_id = $2 AND status = 'ACTIVE'`,
    [clientId, vendorId],
  );
  return result.rows[0] ?? null;
}

async function listByClient(
  clientId: string,
  filters: HandymanProviderFilters = {},
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanProviderRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [clientId];

  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }

  const whereClause = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';

  const result = await executor.query<HandymanProviderRecord>(
    `SELECT ${HANDYMAN_PROVIDER_SELECT}
     FROM handyman_providers
     WHERE client_id = $1
     ${whereClause}
     ORDER BY created_at ASC, id ASC`,
    values,
  );
  return result.rows;
}

async function create(
  input: NewHandymanProvider,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanProviderRecord> {
  const result = await executor.query<HandymanProviderRecord>(
    `INSERT INTO handyman_providers
       (id, client_id, vendor_id, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${HANDYMAN_PROVIDER_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.vendorId,
      input.status,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

/**
 * Guarded lifecycle transition: the UPDATE only applies when the row is
 * still in `expectedStatus`, so two concurrent lifecycle commands cannot
 * both succeed (the CR-HM-BE-01 closure-hardening idiom). Returns null when
 * the guard fails (row missing, or no longer in `expectedStatus`).
 */
async function updateStatusFrom(
  id: string,
  expectedStatus: HandymanProviderStatus,
  status: HandymanProviderStatus,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanProviderRecord | null> {
  const result = await executor.query<HandymanProviderRecord>(
    `UPDATE handyman_providers
     SET status = $3, updated_at = NOW()
     WHERE id = $1 AND status = $2
     RETURNING ${HANDYMAN_PROVIDER_SELECT}`,
    [id, expectedStatus, status],
  );
  return result.rows[0] ?? null;
}

export const handymanProviderRepository = {
  create,
  findActiveByClientAndVendor,
  findById,
  listByClient,
  updateStatusFrom,
};
