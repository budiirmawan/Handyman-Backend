import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewPermitValidity,
  PermitValidityFilters,
  PermitValidityRecord,
  RevokePermitValidityInput,
} from './permit-validity.types';

const SELECT = `
  pv.id,
  pv.permit_application_id AS "permitApplicationId",
  pa.permit_id AS "permitId",
  p.permit_number AS "permitReference",
  p.client_id AS "clientId",
  p.building_id AS "buildingId",
  p.contractor_context_type AS "contractorContextType",
  p.contractor_vendor_id AS "contractorVendorId",
  pa.status AS "applicationStatus",
  pv.valid_from AS "validFrom",
  pv.valid_until AS "validUntil",
  pv.status,
  pv.activated_at AS "activatedAt",
  pv.expired_at AS "expiredAt",
  pv.revoked_at AS "revokedAt",
  pv.revoked_by_user_id AS "revokedByUserId",
  pv.notes,
  pv.revocation_notes AS "revocationNotes",
  pv.created_by_user_id AS "createdByUserId",
  pv.created_at AS "createdAt",
  pv.updated_at AS "updatedAt"
`;

const JOINS = `
  FROM permit_validities pv
  JOIN permit_applications pa ON pa.id = pv.permit_application_id
  JOIN permits p ON p.id = pa.permit_id
`;

async function create(input: NewPermitValidity): Promise<PermitValidityRecord> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO permit_validities
       (id, permit_application_id, valid_from, valid_until, status,
        activated_at, expired_at, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.permitApplicationId,
      input.validFrom,
      input.validUntil,
      input.status,
      input.activatedAt,
      input.expiredAt,
      input.notes,
      input.createdByUserId,
    ],
  );
  return (await findById(id)) as PermitValidityRecord;
}

async function findById(id: string): Promise<PermitValidityRecord | null> {
  const result = await getPool().query<PermitValidityRecord>(
    `SELECT ${SELECT} ${JOINS} WHERE pv.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findLatestByPermitId(
  permitId: string,
): Promise<PermitValidityRecord | null> {
  const result = await getPool().query<PermitValidityRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE p.id = $1
     ORDER BY pv.created_at DESC, pv.id DESC
     LIMIT 1`,
    [permitId],
  );
  return result.rows[0] ?? null;
}

async function findOpenByApplicationId(
  permitApplicationId: string,
): Promise<PermitValidityRecord | null> {
  const result = await getPool().query<PermitValidityRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE pv.permit_application_id = $1
       AND pv.status IN ('PENDING', 'VALID')
     ORDER BY pv.created_at DESC
     LIMIT 1`,
    [permitApplicationId],
  );
  return result.rows[0] ?? null;
}

async function listByPermitId(
  permitId: string,
): Promise<PermitValidityRecord[]> {
  const result = await getPool().query<PermitValidityRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE p.id = $1
     ORDER BY pv.created_at, pv.id`,
    [permitId],
  );
  return result.rows;
}

async function list(
  filters: PermitValidityFilters,
  accessibleBuildingIds: string[],
): Promise<PermitValidityRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];
  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['p.building_id = ANY($1::uuid[])'];
  if (filters.permitId) {
    values.push(filters.permitId);
    conditions.push(`p.id = $${values.length}`);
  }
  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`p.building_id = $${values.length}`);
  }
  if (filters.validFrom) {
    values.push(filters.validFrom);
    conditions.push(`pv.valid_from >= $${values.length}`);
  }
  if (filters.validUntil) {
    values.push(filters.validUntil);
    conditions.push(`pv.valid_until <= $${values.length}`);
  }
  if (filters.validAt) {
    values.push(filters.validAt);
    conditions.push(`pv.valid_from <= $${values.length}
      AND pv.valid_until > $${values.length}`);
  }
  const result = await getPool().query<PermitValidityRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE ${conditions.join(' AND ')}
     ORDER BY pv.valid_from DESC, pv.created_at DESC`,
    values,
  );
  return result.rows;
}

async function transitionDue(id: string): Promise<PermitValidityRecord | null> {
  await getPool().query<{ id: string }>(
    `UPDATE permit_validities
     SET status = CASE
           WHEN valid_until <= NOW() THEN 'EXPIRED'
           WHEN valid_from <= NOW() THEN 'VALID'
           ELSE status
         END,
         activated_at = CASE
           WHEN valid_until <= NOW() THEN COALESCE(activated_at, valid_from)
           WHEN valid_from <= NOW() THEN COALESCE(activated_at, NOW())
           ELSE activated_at
         END,
         expired_at = CASE
           WHEN valid_until <= NOW() THEN valid_until
           ELSE expired_at
         END,
         updated_at = CASE
           WHEN valid_until <= NOW()
             OR (status = 'PENDING' AND valid_from <= NOW())
           THEN NOW()
           ELSE updated_at
         END
     WHERE id = $1 AND status IN ('PENDING', 'VALID')
     RETURNING id`,
    [id],
  );
  return findById(id);
}

async function revoke(
  id: string,
  input: RevokePermitValidityInput,
  actorUserId: string,
): Promise<PermitValidityRecord | null> {
  const result = await getPool().query<{ id: string }>(
    `UPDATE permit_validities
     SET status = 'REVOKED', revoked_at = NOW(), revoked_by_user_id = $2,
         revocation_notes = $3, updated_at = NOW()
     WHERE id = $1 AND status IN ('PENDING', 'VALID')
     RETURNING id`,
    [id, actorUserId, input.revocationNotes ?? null],
  );
  return result.rows[0] ? findById(id) : null;
}

export const permitValidityRepository = {
  create,
  findById,
  findLatestByPermitId,
  findOpenByApplicationId,
  list,
  listByPermitId,
  revoke,
  transitionDue,
};
