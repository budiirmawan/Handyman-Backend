import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  CrewWorkerCandidate,
  HandymanWorkCrewFilters,
  HandymanWorkCrewMemberFilters,
  HandymanWorkCrewMemberRecord,
  HandymanWorkCrewMemberStatus,
  HandymanWorkCrewRecord,
  HandymanWorkCrewStatus,
  NewHandymanWorkCrew,
  NewHandymanWorkCrewMember,
} from './handyman-work-crew.types';

/**
 * CR-HM-BE-04 RUN 1 — Handyman Work Crew persistence.
 *
 * Follows the CR-HM-BE-02 repository idiom: aliased SELECT projection, an
 * injectable executor (defaults to the shared pool) so the service composes
 * inside a guarded transaction, row locks for membership serialization, and
 * guarded status transitions so concurrent lifecycle commands cannot both
 * succeed.
 *
 * Structural authorities (migration 0353) the service translates into domain
 * errors:
 * - `handyman_work_crews_one_active_code_per_provider` — one ACTIVE crew per
 *   (provider, code),
 * - `handyman_work_crew_members_one_active_per_crew_binding` — one ACTIVE
 *   membership per (crew, binding),
 * - `handyman_work_crew_members_one_active_lead_per_crew` — AT MOST one
 *   ACTIVE LEAD_WORKER per crew.
 *
 * Cross-authority reads (`vendor_workforce_bindings` joined to
 * `workforce_profiles` and `organizations`) are CONSUMED read-only here —
 * this repository never writes to any BE-03/BE-06 table.
 */

const CREW_SELECT = `
  id,
  client_id AS "clientId",
  handyman_provider_id AS "handymanProviderId",
  crew_code AS "crewCode",
  crew_name AS "crewName",
  status,
  created_by_user_id AS "createdByUserId",
  updated_by_user_id AS "updatedByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const MEMBER_SELECT = `
  id,
  client_id AS "clientId",
  crew_id AS "crewId",
  vendor_workforce_binding_id AS "vendorWorkforceBindingId",
  crew_role AS "crewRole",
  status,
  effective_from AS "effectiveFrom",
  effective_to AS "effectiveTo",
  added_at AS "addedAt",
  added_by_user_id AS "addedByUserId",
  removed_at AS "removedAt",
  removed_by_user_id AS "removedByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

type CrewWorkerCandidateRow = {
  binding_id: string;
  binding_status: string;
  vendor_id: string;
  workforce_profile_id: string;
  profile_status: string;
  workforce_type: string;
  profile_client_id: string;
};

async function findById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanWorkCrewRecord | null> {
  const result = await executor.query<HandymanWorkCrewRecord>(
    `SELECT ${CREW_SELECT}
     FROM handyman_work_crews
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Locks the crew row for the duration of the transaction. Every membership
 * mutation takes this lock first, serializing all member adds, removals, and
 * lead changes per crew (the guarded-transaction seam — no distributed
 * locking infrastructure).
 */
async function lockById(
  id: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<HandymanWorkCrewRecord | null> {
  const result = await executor.query<HandymanWorkCrewRecord>(
    `SELECT ${CREW_SELECT}
     FROM handyman_work_crews
     WHERE id = $1
     FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveByProviderAndCode(
  handymanProviderId: string,
  crewCode: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanWorkCrewRecord | null> {
  const result = await executor.query<HandymanWorkCrewRecord>(
    `SELECT ${CREW_SELECT}
     FROM handyman_work_crews
     WHERE handyman_provider_id = $1 AND crew_code = $2 AND status = 'ACTIVE'`,
    [handymanProviderId, crewCode],
  );
  return result.rows[0] ?? null;
}

async function listByClient(
  clientId: string,
  filters: HandymanWorkCrewFilters = {},
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanWorkCrewRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [clientId];

  if (filters.handymanProviderId) {
    values.push(filters.handymanProviderId);
    clauses.push(`handyman_provider_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }

  const whereClause = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';

  const result = await executor.query<HandymanWorkCrewRecord>(
    `SELECT ${CREW_SELECT}
     FROM handyman_work_crews
     WHERE client_id = $1
     ${whereClause}
     ORDER BY created_at ASC, id ASC`,
    values,
  );
  return result.rows;
}

async function create(
  input: NewHandymanWorkCrew,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanWorkCrewRecord> {
  const result = await executor.query<HandymanWorkCrewRecord>(
    `INSERT INTO handyman_work_crews
       (id, client_id, handyman_provider_id, crew_code, crew_name, status,
        created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${CREW_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.handymanProviderId,
      input.crewCode,
      input.crewName,
      input.status,
      input.createdByUserId,
      input.updatedByUserId,
    ],
  );
  return result.rows[0];
}

/**
 * Metadata update (rename). `crew_code`, `client_id`, and
 * `handyman_provider_id` are immutable identity facts — no update surface
 * exists for them.
 */
async function updateMetadata(
  id: string,
  crewName: string,
  updatedByUserId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanWorkCrewRecord | null> {
  const result = await executor.query<HandymanWorkCrewRecord>(
    `UPDATE handyman_work_crews
     SET crew_name = $2, updated_by_user_id = $3, updated_at = NOW()
     WHERE id = $1
     RETURNING ${CREW_SELECT}`,
    [id, crewName, updatedByUserId],
  );
  return result.rows[0] ?? null;
}

/**
 * Guarded lifecycle transition: the UPDATE only applies while the row is
 * still in `expectedStatus`, so two concurrent lifecycle commands cannot
 * both succeed (the CR-HM-BE-02 idiom). Returns null when the guard fails.
 */
async function updateStatusFrom(
  id: string,
  expectedStatus: HandymanWorkCrewStatus,
  status: HandymanWorkCrewStatus,
  updatedByUserId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanWorkCrewRecord | null> {
  const result = await executor.query<HandymanWorkCrewRecord>(
    `UPDATE handyman_work_crews
     SET status = $3, updated_by_user_id = $4, updated_at = NOW()
     WHERE id = $1 AND status = $2
     RETURNING ${CREW_SELECT}`,
    [id, expectedStatus, status, updatedByUserId],
  );
  return result.rows[0] ?? null;
}

async function createMember(
  input: NewHandymanWorkCrewMember,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanWorkCrewMemberRecord> {
  const result = await executor.query<HandymanWorkCrewMemberRecord>(
    `INSERT INTO handyman_work_crew_members
       (id, client_id, crew_id, vendor_workforce_binding_id, crew_role,
        status, added_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${MEMBER_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.crewId,
      input.vendorWorkforceBindingId,
      input.crewRole,
      input.status,
      input.addedByUserId,
    ],
  );
  return result.rows[0];
}

async function findMemberById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanWorkCrewMemberRecord | null> {
  const result = await executor.query<HandymanWorkCrewMemberRecord>(
    `SELECT ${MEMBER_SELECT}
     FROM handyman_work_crew_members
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveMemberByCrewAndBinding(
  crewId: string,
  vendorWorkforceBindingId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanWorkCrewMemberRecord | null> {
  const result = await executor.query<HandymanWorkCrewMemberRecord>(
    `SELECT ${MEMBER_SELECT}
     FROM handyman_work_crew_members
     WHERE crew_id = $1
       AND vendor_workforce_binding_id = $2
       AND status = 'ACTIVE'`,
    [crewId, vendorWorkforceBindingId],
  );
  return result.rows[0] ?? null;
}

async function findActiveLead(
  crewId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanWorkCrewMemberRecord | null> {
  const result = await executor.query<HandymanWorkCrewMemberRecord>(
    `SELECT ${MEMBER_SELECT}
     FROM handyman_work_crew_members
     WHERE crew_id = $1 AND crew_role = 'LEAD_WORKER' AND status = 'ACTIVE'`,
    [crewId],
  );
  return result.rows[0] ?? null;
}

async function countActiveLeads(
  crewId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<number> {
  const result = await executor.query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count
     FROM handyman_work_crew_members
     WHERE crew_id = $1 AND crew_role = 'LEAD_WORKER' AND status = 'ACTIVE'`,
    [crewId],
  );
  return Number.parseInt(result.rows[0]?.count ?? '0', 10);
}

async function listMembers(
  crewId: string,
  filters: HandymanWorkCrewMemberFilters = {},
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanWorkCrewMemberRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [crewId];

  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }

  const whereClause = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';

  const result = await executor.query<HandymanWorkCrewMemberRecord>(
    `SELECT ${MEMBER_SELECT}
     FROM handyman_work_crew_members
     WHERE crew_id = $1
     ${whereClause}
     ORDER BY added_at ASC, id ASC`,
    values,
  );
  return result.rows;
}

/**
 * Guarded membership deactivation: closes the ACTIVE row with full removal
 * attribution and never touches historical columns otherwise. Rows are never
 * deleted and INACTIVE rows are never updated again — the history is
 * immutable evidence. Returns null when the guard fails (row missing, or no
 * longer ACTIVE).
 */
async function deactivateMember(
  id: string,
  removedByUserId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanWorkCrewMemberRecord | null> {
  const result = await executor.query<HandymanWorkCrewMemberRecord>(
    `UPDATE handyman_work_crew_members
     SET status = 'INACTIVE',
         effective_to = NOW(),
         removed_at = NOW(),
         removed_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${MEMBER_SELECT}`,
    [id, removedByUserId],
  );
  return result.rows[0] ?? null;
}

/**
 * Transactional worker-validation read through the EXISTING personnel
 * authority (BE-06F binding → BE-03C profile → organization → client).
 * Locks the binding row (`FOR UPDATE OF b`) so a concurrent binding
 * deactivation cannot slip between validation and membership insert; the
 * person-master rows are read without locking.
 */
async function lockWorkerCandidate(
  vendorWorkforceBindingId: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<CrewWorkerCandidate | null> {
  const result = await executor.query<CrewWorkerCandidateRow>(
    `SELECT
       b.id                     AS binding_id,
       b.status                 AS binding_status,
       b.vendor_id              AS vendor_id,
       b.workforce_profile_id   AS workforce_profile_id,
       p.status                 AS profile_status,
       p.workforce_type         AS workforce_type,
       o.client_id              AS profile_client_id
     FROM vendor_workforce_bindings b
     JOIN workforce_profiles p ON p.id = b.workforce_profile_id
     JOIN organizations o ON o.id = p.organization_id
     WHERE b.id = $1
     FOR UPDATE OF b`,
    [vendorWorkforceBindingId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    bindingId: row.binding_id,
    bindingStatus: row.binding_status,
    vendorId: row.vendor_id,
    workforceProfileId: row.workforce_profile_id,
    profileStatus: row.profile_status,
    workforceType: row.workforce_type,
    profileClientId: row.profile_client_id,
  };
}

export const handymanWorkCrewRepository = {
  countActiveLeads,
  create,
  createMember,
  deactivateMember,
  findActiveByProviderAndCode,
  findActiveLead,
  findActiveMemberByCrewAndBinding,
  findById,
  findMemberById,
  listByClient,
  listMembers,
  lockById,
  lockWorkerCandidate,
  updateMetadata,
  updateStatusFrom,
};

export type { HandymanWorkCrewMemberStatus };
