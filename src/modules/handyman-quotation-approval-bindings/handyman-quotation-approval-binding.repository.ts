import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanQuotationApprovalBindingRecord,
  HandymanQuotationAuthorityStatus,
  HandymanTenantPicBindingFacts,
  HandymanQuotationBindingLineage,
} from './handyman-quotation-approval-binding.types';

/**
 * W03 PART 03B2 — raw-SQL repository over `handyman_quotation_approval_bindings`
 * (the table `0437` creates, with the guard that already enforces B1–B5,
 * R-1.2, B13, B14, B18 and MC1').
 *
 * WHY RAW SQL AND NOT A REPOSITORY IMPORT. `handyman-quotations` owns the
 * commercial ledgers and its repositories own their column lists; this module
 * owns exactly one table and reads four authority tables (`handyman_service_
 * requests`, `tenant_pics`, `tenant_building_contexts`,
 * `tenant_space_relationships`) for eligibility only. Every one of those reads
 * is a SELECT — this file contains NO write to any table but the binding
 * ledger, which is what ADD-A B9 ("binding is not approval") means at the SQL
 * level: the INSERT surface here cannot reach `handyman_quotation_decisions`
 * or `handyman_quotation_versions` even by accident.
 *
 * THE GUARD PREDICATES ARE REUSED VERBATIM, not paraphrased. `occupancyStatus`
 * / `spaceStatus` / PIC liveness re-evaluate the SAME predicates the trigger
 * uses, so the service pre-check and the DB floor can never disagree about
 * what "eligible" means (B20: service for the code, DB as the floor).
 */

type Query = Pick<PoolClient, 'query'>;

const BINDING_COLUMNS = `
  id, quotation_id, handyman_request_id, client_id, tenant_company_id,
  building_id, space_id, tenant_pic_id, binding_version,
  supersedes_binding_id, status, effective_from, effective_until,
  occupancy_authority_id, space_authority_id, granted_by_user_id,
  granted_at, revoked_by_user_id, revoked_at, created_at, updated_at`;

function toRecord(row: Record<string, unknown>): HandymanQuotationApprovalBindingRecord {
  return {
    id: String(row.id),
    quotationId: String(row.quotation_id),
    handymanRequestId: String(row.handyman_request_id),
    clientId: String(row.client_id),
    tenantCompanyId: String(row.tenant_company_id),
    buildingId: String(row.building_id),
    spaceId: row.space_id ? String(row.space_id) : null,
    tenantPicId: String(row.tenant_pic_id),
    bindingVersion: Number(row.binding_version),
    supersedesBindingId: row.supersedes_binding_id
      ? String(row.supersedes_binding_id)
      : null,
    status: row.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE',
    effectiveFrom: row.effective_from as Date,
    effectiveUntil: row.effective_until ? (row.effective_until as Date) : null,
    occupancyAuthorityId: String(row.occupancy_authority_id),
    spaceAuthorityId: row.space_authority_id ? String(row.space_authority_id) : null,
    grantedByUserId: String(row.granted_by_user_id),
    grantedAt: row.granted_at as Date,
    revokedByUserId: row.revoked_by_user_id ? String(row.revoked_by_user_id) : null,
    revokedAt: row.revoked_at ? (row.revoked_at as Date) : null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * The thread's authoritative lineage. tenant/building/space/client and the
 * BM-attested PIC come from here and ONLY here (B11): a caller can never bind
 * a PIC into a tenant it does not manage, because the tenant is not an input.
 */
export async function findThreadLineage(
  executor: Query = getPool(),
  handymanRequestId: string,
): Promise<HandymanQuotationBindingLineage | null> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT id, client_id, tenant_company_id, building_id, space_id,
            tenant_pic_id
       FROM handyman_service_requests
      WHERE id = $1`,
    [handymanRequestId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    requestId: String(row.id),
    clientId: String(row.client_id),
    tenantCompanyId: String(row.tenant_company_id),
    buildingId: String(row.building_id),
    spaceId: row.space_id ? String(row.space_id) : null,
    requestTenantPicId: row.tenant_pic_id ? String(row.tenant_pic_id) : null,
  };
}

/** Tenant + client liveness (B5) and the client the lineage must agree with. */
export async function findTenantCompanyAndClientStatuses(
  executor: Query,
  tenantCompanyId: string,
  clientId: string,
): Promise<{ tenantStatus: string | null; tenantClient: string | null; clientStatus: string | null }> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT tc.status AS tenant_status, tc.client_id AS tenant_client,
            c.status  AS client_status
       FROM tenant_companies tc
       LEFT JOIN clients c ON c.id = tc.client_id
      WHERE tc.id = $1
        AND tc.client_id = $2`,
    [tenantCompanyId, clientId],
  );
  const row = result.rows[0];
  return {
    tenantStatus: row?.tenant_status ? String(row.tenant_status) : null,
    tenantClient: row?.tenant_client ? String(row.tenant_client) : null,
    clientStatus: row?.client_status ? String(row.client_status) : null,
  };
}

/** PIC facts for B1/B2/MC1' — deliberately no name/email/phone (no PII). */
export async function findTenantPicFacts(
  executor: Query,
  tenantPicId: string,
): Promise<HandymanTenantPicBindingFacts | null> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT id, tenant_company_id, status, user_id
       FROM tenant_pics
      WHERE id = $1`,
    [tenantPicId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    tenantCompanyId: String(row.tenant_company_id),
    status: String(row.status),
    userId: row.user_id ? String(row.user_id) : null,
  };
}

/**
 * B3: the ACTIVE, effective `tenant_building_contexts` row for exactly
 * (tenant, building) covering `at`. Predicate is `0437`'s own, so the id this
 * returns is always an id the guard accepts.
 */
export async function findLiveOccupancyAuthorityId(
  executor: Query,
  input: { tenantCompanyId: string; buildingId: string; at: Date },
): Promise<string | null> {
  const result = await executor.query<{ id: string }>(
    `SELECT tbc.id
       FROM tenant_building_contexts tbc
      WHERE tbc.tenant_company_id = $1
        AND tbc.building_id = $2
        AND tbc.status = 'ACTIVE'
        AND (tbc.effective_from IS NULL OR tbc.effective_from <= $3)
        AND (tbc.effective_until IS NULL OR tbc.effective_until >= $3)
      ORDER BY tbc.effective_from NULLS FIRST, tbc.created_at DESC
      LIMIT 1`,
    [input.tenantCompanyId, input.buildingId, input.at],
  );
  return result.rows[0]?.id ?? null;
}

/** B4 counterpart: the ACTIVE space row for exactly (tenant, building, space). */
export async function findLiveSpaceAuthorityId(
  executor: Query,
  input: {
    tenantCompanyId: string;
    buildingId: string;
    spaceId: string;
    at: Date;
  },
): Promise<string | null> {
  const result = await executor.query<{ id: string }>(
    `SELECT tsr.id
       FROM tenant_space_relationships tsr
      WHERE tsr.tenant_company_id = $1
        AND tsr.building_id = $2
        AND tsr.space_id = $3
        AND tsr.status = 'ACTIVE'
        AND (tsr.effective_from IS NULL OR tsr.effective_from <= $4)
        AND (tsr.effective_until IS NULL OR tsr.effective_until >= $4)
      ORDER BY tsr.effective_from NULLS FIRST, tsr.created_at DESC
      LIMIT 1`,
    [input.tenantCompanyId, input.buildingId, input.spaceId, input.at],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Read-path liveness of a snapshotted authority row (B16/B17): MISSING when the
 * row is gone, INACTIVE when the relationship was closed, EXPIRED when its
 * window no longer covers `at`, ACTIVE otherwise. `tenant_building_contexts`
 * and `tenant_space_relationships` share the column shape, so one query serves
 * both, keyed by table name chosen by the caller.
 */
export async function readAuthorityStatus(
  executor: Query,
  input: {
    table: 'tenant_building_contexts' | 'tenant_space_relationships';
    authorityId: string | null;
    tenantCompanyId: string;
    buildingId: string;
    at: Date;
  },
): Promise<HandymanQuotationAuthorityStatus> {
  if (!input.authorityId) return 'MISSING';
  const result = await executor.query<Record<string, unknown>>(
    `SELECT status, effective_from, effective_until
       FROM ${input.table}
      WHERE id = $1
        AND tenant_company_id = $2
        AND building_id = $3`,
    [input.authorityId, input.tenantCompanyId, input.buildingId],
  );
  const row = result.rows[0];
  if (!row) return 'MISSING';
  if (String(row.status) !== 'ACTIVE') return 'INACTIVE';
  const from = row.effective_from ? (row.effective_from as Date) : null;
  const until = row.effective_until ? (row.effective_until as Date) : null;
  if (from && from.getTime() > input.at.getTime()) return 'EXPIRED';
  if (until && until.getTime() < input.at.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}

/** The thread's current ACTIVE binding (at most one — `…_one_active`). */
export async function findActiveBinding(
  executor: Query = getPool(),
  quotationId: string,
  options: { forUpdate?: boolean } = {},
): Promise<HandymanQuotationApprovalBindingRecord | null> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT ${BINDING_COLUMNS}
       FROM handyman_quotation_approval_bindings
      WHERE quotation_id = $1
        AND status = 'ACTIVE'
      LIMIT 1
      ${options.forUpdate ? 'FOR UPDATE' : ''}`,
    [quotationId],
  );
  return result.rows[0] ? toRecord(result.rows[0]) : null;
}

/** The thread's highest binding row, ACTIVE or not (the supersede head). */
export async function findBindingHead(
  executor: Query,
  quotationId: string,
): Promise<HandymanQuotationApprovalBindingRecord | null> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT ${BINDING_COLUMNS}
       FROM handyman_quotation_approval_bindings
      WHERE quotation_id = $1
      ORDER BY binding_version DESC
      LIMIT 1`,
    [quotationId],
  );
  return result.rows[0] ? toRecord(result.rows[0]) : null;
}

/** Newest-first bounded history (ids + version + status, no narrative). */
export async function listBindingHistory(
  executor: Query = getPool(),
  quotationId: string,
  limit = 20,
): Promise<HandymanQuotationApprovalBindingRecord[]> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT ${BINDING_COLUMNS}
       FROM handyman_quotation_approval_bindings
      WHERE quotation_id = $1
      ORDER BY binding_version DESC
      LIMIT $2`,
    [quotationId, limit],
  );
  return result.rows.map(toRecord);
}

/** Exact-row read used to replay an idempotent act onto its own row. */
export async function findBindingById(
  executor: Query,
  id: string,
): Promise<HandymanQuotationApprovalBindingRecord | null> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT ${BINDING_COLUMNS}
       FROM handyman_quotation_approval_bindings
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? toRecord(result.rows[0]) : null;
}

export type InsertHandymanQuotationApprovalBindingInput = {
  quotationId: string;
  handymanRequestId: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
  tenantPicId: string;
  bindingVersion: number;
  supersedesBindingId: string | null;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  occupancyAuthorityId: string;
  spaceAuthorityId: string | null;
  grantedByUserId: string;
};

/**
 * The module's ONLY INSERT. Every column the guard cross-checks against the
 * request row is passed from the server-derived lineage, never from the body
 * (B11); the ledger refuses anything else. `status` is the column default
 * 'ACTIVE' — a binding is never minted already-revoked.
 */
export async function insertBinding(
  executor: Query,
  input: InsertHandymanQuotationApprovalBindingInput,
): Promise<HandymanQuotationApprovalBindingRecord> {
  const result = await executor.query<Record<string, unknown>>(
    `INSERT INTO handyman_quotation_approval_bindings
       (id, quotation_id, handyman_request_id, client_id, tenant_company_id,
        building_id, space_id, tenant_pic_id, binding_version,
        supersedes_binding_id, effective_from, effective_until,
        occupancy_authority_id, space_authority_id, granted_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING ${BINDING_COLUMNS}`,
    [
      randomUUID(),
      input.quotationId,
      input.handymanRequestId,
      input.clientId,
      input.tenantCompanyId,
      input.buildingId,
      input.spaceId,
      input.tenantPicId,
      input.bindingVersion,
      input.supersedesBindingId,
      input.effectiveFrom,
      input.effectiveUntil,
      input.occupancyAuthorityId,
      input.spaceAuthorityId,
      input.grantedByUserId,
    ],
  );
  return toRecord(result.rows[0] as Record<string, unknown>);
}

/**
 * The module's ONLY UPDATE, and the only mutation the guard permits:
 * ACTIVE → REVOKED for exactly one row. `revoked_at` is server-clock
 * (`clock_timestamp()`), never caller-supplied, so a stated cutoff can only
 * tighten the record while the authoritative end stays DB-derived.
 */
export async function revokeBinding(
  executor: Query,
  input: { id: string; revokedByUserId: string },
): Promise<HandymanQuotationApprovalBindingRecord | null> {
  const result = await executor.query<Record<string, unknown>>(
    `UPDATE handyman_quotation_approval_bindings
        SET status = 'REVOKED',
            revoked_by_user_id = $2,
            revoked_at = clock_timestamp(),
            updated_at = NOW()
      WHERE id = $1
        AND status = 'ACTIVE'
     RETURNING ${BINDING_COLUMNS}`,
    [input.id, input.revokedByUserId],
  );
  return result.rows[0] ? toRecord(result.rows[0]) : null;
}

/** B13: is any version of the thread ISSUED and still undecided? */
export async function hasIssuedUndecidedVersion(
  executor: Query,
  quotationId: string,
): Promise<boolean> {
  const result = await executor.query<{ found: string | null }>(
    `SELECT 1 AS found
       FROM handyman_quotation_versions v
      WHERE v.quotation_id = $1
        AND v.status = 'ISSUED'
        AND NOT EXISTS (
          SELECT 1 FROM handyman_quotation_decisions d
           WHERE d.quotation_version_id = v.id
        )
      LIMIT 1`,
    [quotationId],
  );
  return result.rows.length > 0;
}

/** B18: does the thread carry ANY decision row (then it is frozen)? */
export async function hasAnyDecision(
  executor: Query,
  quotationId: string,
): Promise<boolean> {
  const result = await executor.query<{ found: string | null }>(
    `SELECT 1 AS found
       FROM handyman_quotation_decisions d
      WHERE d.quotation_id = $1
      LIMIT 1`,
    [quotationId],
  );
  return result.rows.length > 0;
}

export const handymanQuotationApprovalBindingRepository = {
  findThreadLineage,
  findTenantCompanyAndClientStatuses,
  findTenantPicFacts,
  findLiveOccupancyAuthorityId,
  findLiveSpaceAuthorityId,
  readAuthorityStatus,
  findActiveBinding,
  findBindingHead,
  listBindingHistory,
  findBindingById,
  insertBinding,
  revokeBinding,
  hasIssuedUndecidedVersion,
  hasAnyDecision,
};
