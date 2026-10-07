import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanCommonMaterialProfileFilters,
  HandymanCommonMaterialProfileRecord,
  NewHandymanCommonMaterialProfile,
} from './handyman-common-material-profile.types';

/**
 * CR-HM-02 PART 02 — Handyman Common Material Profile repository.
 *
 * Same executor-first convention as the service-catalog/variant
 * repositories. `typical_quantity` is read with a float8 cast so the
 * catalog-metadata quantity arrives as a number (precision is bounded by
 * NUMERIC(12,3)). Read surfaces are always Client-scoped.
 */

type ProfileRow = Omit<
  HandymanCommonMaterialProfileRecord,
  'typicalQuantity' | 'createdAt' | 'updatedAt'
> & {
  typicalQuantity: number | null;
  createdAt: Date;
  updatedAt: Date;
};

const PROFILE_SELECT = `
  id,
  client_id AS "clientId",
  service_catalog_id AS "serviceCatalogId",
  service_variant_id AS "serviceVariantId",
  inventory_item_id AS "inventoryItemId",
  specification,
  compatibility,
  typical_quantity::float8 AS "typicalQuantity",
  commonality,
  customer_material_option AS "customerMaterialOption",
  status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function insertProfile(
  executor: Pick<PoolClient, 'query'> = getPool(),
  profile: NewHandymanCommonMaterialProfile,
): Promise<HandymanCommonMaterialProfileRecord> {
  const result = await executor.query<ProfileRow>(
    `INSERT INTO handyman_common_material_profiles
       (id, client_id, service_catalog_id, service_variant_id,
        inventory_item_id, specification, compatibility, typical_quantity,
        commonality, customer_material_option, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', $11)
     RETURNING ${PROFILE_SELECT}`,
    [
      randomUUID(),
      profile.clientId,
      profile.serviceCatalogId,
      profile.serviceVariantId,
      profile.inventoryItemId,
      profile.specification,
      profile.compatibility,
      profile.typicalQuantity,
      profile.commonality,
      profile.customerMaterialOption,
      profile.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanCommonMaterialProfileRecord | null> {
  const result = await executor.query<ProfileRow>(
    `SELECT ${PROFILE_SELECT} FROM handyman_common_material_profiles
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Duplicate-association probe (service-level vs variant-level identity). */
async function findDuplicate(
  executor: Pick<PoolClient, 'query'> = getPool(),
  serviceCatalogId: string,
  serviceVariantId: string | null,
  inventoryItemId: string,
): Promise<HandymanCommonMaterialProfileRecord | null> {
  const result = await executor.query<ProfileRow>(
    `SELECT ${PROFILE_SELECT} FROM handyman_common_material_profiles
      WHERE service_catalog_id = $1
        AND service_variant_id IS NOT DISTINCT FROM $2
        AND inventory_item_id = $3`,
    [serviceCatalogId, serviceVariantId, inventoryItemId],
  );
  return result.rows[0] ?? null;
}

/**
 * Client-scoped read foundation. `clientId` is mandatory; optional
 * service/variant filters are structurally scope-safe (a cross-Client id
 * matches nothing because of the composite scope-FK + client predicate).
 */
async function listScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  filters: HandymanCommonMaterialProfileFilters,
): Promise<HandymanCommonMaterialProfileRecord[]> {
  const conditions: string[] = ['client_id = $1'];
  const values: unknown[] = [filters.clientId];
  let idx = 2;

  if (filters.serviceCatalogId !== undefined) {
    conditions.push(`service_catalog_id = $${idx++}`);
    values.push(filters.serviceCatalogId);
  }
  if (filters.serviceVariantId !== undefined) {
    conditions.push(`service_variant_id = $${idx++}`);
    values.push(filters.serviceVariantId);
  }
  if (filters.status !== undefined) {
    conditions.push(`status = $${idx++}`);
    values.push(filters.status);
  }

  const result = await executor.query<ProfileRow>(
    `SELECT ${PROFILE_SELECT} FROM handyman_common_material_profiles
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ASC, id ASC`,
    values,
  );
  return result.rows;
}

export const handymanCommonMaterialProfileRepository = {
  insertProfile,
  findById,
  findDuplicate,
  listScoped,
};
