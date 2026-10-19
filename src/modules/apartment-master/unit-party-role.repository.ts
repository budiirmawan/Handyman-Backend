import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  NewUnitPartyRole,
  UnitPartyRoleFilters,
  UnitPartyRoleRecord,
} from './unit-party-role.types';

/**
 * CR-HM-MASTER-IND-01 — Unit party role repository.
 *
 * Follows the repository convention: an optional executor first so callers
 * can join an existing transaction, the shared pool otherwise. Every read is
 * keyed by `client_id` (mandatory predicate) — a role can never leak across
 * the Client boundary through a list surface.
 */
const ROLE_SELECT = `
  SELECT upr.id,
         upr.client_id AS "clientId",
         upr.building_id AS "buildingId",
         upr.space_id AS "unitId",
         upr.tenant_company_id AS "tenantCompanyId",
         tc.tenant_code AS "tenantCode",
         tc.tenant_name AS "tenantName",
         tc.party_kind AS "partyKind",
         upr.party_role AS "partyRole",
         upr.effective_from AS "effectiveFrom",
         upr.effective_until AS "effectiveUntil",
         upr.status,
         upr.created_by_user_id AS "createdByUserId",
         upr.created_at AS "createdAt",
         upr.updated_at AS "updatedAt"
    FROM unit_party_roles upr
    JOIN tenant_companies tc
      ON tc.id = upr.tenant_company_id AND tc.client_id = upr.client_id
`;

async function insert(
  role: NewUnitPartyRole,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<UnitPartyRoleRecord> {
  const id = randomUUID();
  await executor.query(
    `INSERT INTO unit_party_roles
       (id, client_id, building_id, space_id, tenant_company_id, party_role,
        effective_from, effective_until, status, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9)`,
    [
      id,
      role.clientId,
      role.buildingId,
      role.unitId,
      role.tenantCompanyId,
      role.partyRole,
      role.effectiveFrom,
      role.effectiveUntil,
      role.createdByUserId,
    ],
  );
  const result = await executor.query<UnitPartyRoleRecord>(
    `${ROLE_SELECT} WHERE upr.id = $1`,
    [id],
  );
  return result.rows[0];
}

async function findById(
  id: string,
): Promise<UnitPartyRoleRecord | null> {
  const result = await getPool().query<UnitPartyRoleRecord>(
    `${ROLE_SELECT} WHERE upr.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveByUnitRoleParty(input: {
  clientId: string;
  unitId: string;
  partyRole: string;
  tenantCompanyId: string;
}): Promise<UnitPartyRoleRecord | null> {
  const result = await getPool().query<UnitPartyRoleRecord>(
    `${ROLE_SELECT}
      WHERE upr.client_id = $1 AND upr.space_id = $2
        AND upr.party_role = $3 AND upr.tenant_company_id = $4
        AND upr.status = 'ACTIVE'
      LIMIT 1`,
    [input.clientId, input.unitId, input.partyRole, input.tenantCompanyId],
  );
  return result.rows[0] ?? null;
}

async function listByUnit(input: {
  clientId: string;
  buildingId: string;
  unitId: string;
  filters: UnitPartyRoleFilters;
  limit: number;
  offset: number;
}): Promise<{ items: UnitPartyRoleRecord[]; total: number }> {
  const conditions = [
    'upr.client_id = $1',
    'upr.building_id = $2',
    'upr.space_id = $3',
  ];
  const values: unknown[] = [input.clientId, input.buildingId, input.unitId];

  if (input.filters.partyRole !== undefined) {
    values.push(input.filters.partyRole);
    conditions.push(`upr.party_role = $${values.length}`);
  }
  if (input.filters.status !== undefined) {
    values.push(input.filters.status);
    conditions.push(`upr.status = $${values.length}`);
  }

  const where = conditions.join(' AND ');
  const counted = await getPool().query<{ total: number }>(
    `SELECT count(*)::int AS total
       FROM unit_party_roles upr
       JOIN tenant_companies tc
         ON tc.id = upr.tenant_company_id AND tc.client_id = upr.client_id
      WHERE ${where}`,
    values,
  );

  const pageValues = [...values, input.limit, input.offset];
  const result = await getPool().query<UnitPartyRoleRecord>(
    `${ROLE_SELECT}
      WHERE ${where}
      ORDER BY upr.party_role ASC, upr.effective_from DESC, upr.id ASC
      LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues,
  );

  return { items: result.rows, total: counted.rows[0]?.total ?? 0 };
}

/**
 * Closes a role's effective window. Only the lifecycle transition is
 * writable: identity columns are immutable (also enforced by the migration's
 * context trigger), and history rows are never deleted.
 */
async function end(
  id: string,
  effectiveUntil: Date,
): Promise<UnitPartyRoleRecord | null> {
  await getPool().query(
    `UPDATE unit_party_roles
        SET status = 'INACTIVE',
            effective_until = $2,
            updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'`,
    [id, effectiveUntil],
  );
  return findById(id);
}

export const unitPartyRoleRepository = {
  end,
  findActiveByUnitRoleParty,
  findById,
  insert,
  listByUnit,
};
