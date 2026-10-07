import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanServiceVariantFilters,
  HandymanServiceVariantRecord,
  NewHandymanServiceVariant,
} from './handyman-service-variant.types';

/**
 * CR-HM-02 PART 01 — Handyman Service Variant repository.
 *
 * Follows the `service_catalog` repository convention: every function takes
 * an optional executor first (`Pick<PoolClient, 'query'>`) so callers can
 * participate in a `withTransaction` unit of work; the shared pool is the
 * default. Reads are always Client-scoped: `client_id` is a mandatory
 * predicate everywhere except the by-id lookup, so a variant can never leak
 * across the tenant-isolation boundary through list/find surfaces.
 */

const VARIANT_SELECT = `
  id,
  client_id AS "clientId",
  service_catalog_id AS "serviceCatalogId",
  code,
  name,
  description,
  status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function insertVariant(
  executor: Pick<PoolClient, 'query'> = getPool(),
  variant: NewHandymanServiceVariant,
): Promise<HandymanServiceVariantRecord> {
  const result = await executor.query<HandymanServiceVariantRecord>(
    `INSERT INTO handyman_service_variants
       (id, client_id, service_catalog_id, code, name, description,
        status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)
     RETURNING ${VARIANT_SELECT}`,
    [
      randomUUID(),
      variant.clientId,
      variant.serviceCatalogId,
      variant.code,
      variant.name,
      variant.description,
      variant.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanServiceVariantRecord | null> {
  const result = await executor.query<HandymanServiceVariantRecord>(
    `SELECT ${VARIANT_SELECT} FROM handyman_service_variants WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByCodeForService(
  executor: Pick<PoolClient, 'query'> = getPool(),
  serviceCatalogId: string,
  code: string,
): Promise<HandymanServiceVariantRecord | null> {
  const result = await executor.query<HandymanServiceVariantRecord>(
    `SELECT ${VARIANT_SELECT} FROM handyman_service_variants
      WHERE service_catalog_id = $1 AND code = $2`,
    [serviceCatalogId, code],
  );
  return result.rows[0] ?? null;
}

/**
 * Client-scoped read foundation. `clientId` is mandatory; optional
 * `serviceCatalogId` narrows to one master service (a cross-Client service
 * id structurally yields an empty list, never a leak).
 */
async function listScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  filters: HandymanServiceVariantFilters,
): Promise<HandymanServiceVariantRecord[]> {
  const conditions: string[] = ['client_id = $1'];
  const values: unknown[] = [filters.clientId];
  let idx = 2;

  if (filters.serviceCatalogId !== undefined) {
    conditions.push(`service_catalog_id = $${idx++}`);
    values.push(filters.serviceCatalogId);
  }
  if (filters.status !== undefined) {
    conditions.push(`status = $${idx++}`);
    values.push(filters.status);
  }

  const result = await executor.query<HandymanServiceVariantRecord>(
    `SELECT ${VARIANT_SELECT} FROM handyman_service_variants
      WHERE ${conditions.join(' AND ')}
      ORDER BY code ASC, created_at ASC`,
    values,
  );
  return result.rows;
}

export const handymanServiceVariantRepository = {
  insertVariant,
  findById,
  findByCodeForService,
  listScoped,
};
