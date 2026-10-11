import type { PoolClient } from 'pg';
import type { HandymanQuotationAuthorityStatus } from '../handyman-quotation-approval-bindings';
import type { PicWorkspacePrincipal } from '../handyman-pic-session';

/**
 * W03 PART 03D — reads for the bounded PIC portal.
 *
 * This file is the ONLY place the portal decides what a PIC may see, and it
 * decides it with the credential, never with a staff grant. Concretely: every
 * statement below is keyed by `(handymanRequestId | quotationVersionId)` AND by
 * the session's own `(tenant_company_id, building_id[, space_id])`, so a foreign
 * thread is indistinguishable from a nonexistent one — there is no second query
 * that could confirm existence before the predicate rejects it. What is NOT here
 * is equally load-bearing: no `user_building_assignments`, no
 * `tenant_company.read/manage`, no `assertQuotationThreadBuildingAccess`. The
 * staff predicate cannot be reused here even by accident, because the PIC
 * principal has no local user to scope with (A01 §4 T6, ADD-A B3 "the occupancy
 * half only, NEVER user_building_assignments").
 */

export type PicPortalRequestRow = {
  requestId: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
  /** Lineage snapshot; `03D` reads it, and `03D` never lets a caller set it (C23). */
  lineageTenantPicId: string | null;
  requestStatus: string;
  serviceCatalogId: string;
  serviceVariantId: string | null;
  description: string | null;
};

export type PicPortalVersionRow = {
  quotationVersionId: string;
  quotationId: string;
  handymanRequestId: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
  lineageTenantPicId: string | null;
  requestStatus: string;
  serviceCatalogId: string;
  serviceVariantId: string | null;
  description: string | null;
  versionNumber: number;
  status: string;
  validUntil: Date | null;
  /** M-set inputs. Read for maker-checker ONLY; never projected to a caller. */
  quotationAuthorUserId: string;
  versionAuthorUserId: string;
};

export type PicPortalDecisionRow = {
  quotationDecisionId: string;
  decision: 'APPROVE' | 'REJECT';
  decisionActorType: string;
  decidedByTenantPicId: string | null;
  decidedByPicSessionId: string | null;
  approvalBindingId: string | null;
  decidedAt: Date;
};

type Querier = Pick<PoolClient, 'query'>;

const UUID_CAST = (placeholder: string) => `${placeholder}::uuid`;

/**
 * The request half of the credential predicate. `spaceId` is a narrowing the
 * credential already carries (rule 12: one admission = one tenant-building
 * context, optionally resolved through a space): when the session names a space,
 * a thread in another space of the same building is NOT this caller's to read.
 * A session without a space claim is not narrowed, because nothing in the
 * credential claims one.
 */
export async function findRequestForCredential(
  tx: PoolClient,
  principal: PicWorkspacePrincipal,
  handymanRequestId: string,
): Promise<PicPortalRequestRow | null> {
  const result = await tx.query<Record<string, unknown>>(
    `SELECT r.id, r.client_id, r.tenant_company_id, r.building_id, r.space_id,
            r.tenant_pic_id, r.status, r.service_catalog_id, r.service_variant_id,
            r.description
       FROM handyman_service_requests r
      WHERE r.id = ${UUID_CAST('$1')}
        AND r.tenant_company_id = ${UUID_CAST('$2')}
        AND r.building_id = ${UUID_CAST('$3')}
        AND ($4::uuid IS NULL OR r.space_id = $4::uuid)`,
    [handymanRequestId, principal.tenantCompanyId, principal.buildingId,
      principal.spaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    requestId: String(row.id),
    clientId: String(row.client_id),
    tenantCompanyId: String(row.tenant_company_id),
    buildingId: String(row.building_id),
    spaceId: row.space_id ? String(row.space_id) : null,
    lineageTenantPicId: row.tenant_pic_id ? String(row.tenant_pic_id) : null,
    requestStatus: String(row.status),
    serviceCatalogId: String(row.service_catalog_id),
    serviceVariantId: row.service_variant_id ? String(row.service_variant_id) : null,
    description: row.description === null || row.description === undefined
      ? null
      : String(row.description),
  };
}

/**
 * The presented (ISSUED) version of one thread, locked `FOR SHARE`: exactly one
 * ISSUED version can exist per thread (`0393`'s partial unique index), and a
 * shared lock lets a concurrent decision or supersede serialize without this read
 * ever blocking a writer longer than it must. Revision history is not read here
 * and is not available anywhere on this surface.
 */
export async function findPresentedVersion(
  tx: PoolClient,
  quotationId: string,
): Promise<{
  quotationVersionId: string;
  versionNumber: number;
  status: string;
  validUntil: Date | null;
  versionAuthorUserId: string;
} | null> {
  const result = await tx.query<Record<string, unknown>>(
    `SELECT v.id, v.version_number, v.status, v.valid_until, v.created_by_user_id
       FROM handyman_quotation_versions v
      WHERE v.quotation_id = ${UUID_CAST('$1')}
        AND v.status = 'ISSUED'
      ORDER BY v.version_number DESC
      LIMIT 1
      FOR SHARE OF v`,
    [quotationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    quotationVersionId: String(row.id),
    versionNumber: Number(row.version_number),
    status: String(row.status),
    validUntil: (row.valid_until as Date) ?? null,
    versionAuthorUserId: String(row.created_by_user_id),
  };
}

/**
 * Version-keyed read for the own-decision path, carrying its lineage in the same
 * statement so the credential predicate can be applied to the version's OWN
 * thread — an id that resolves to another tenant's version must fail exactly as
 * an unknown one does, and it must fail in this single statement rather than in
 * a second lookup.
 */
/**
 * Lock strength is a parameter, not a second function, because the WHERE clause IS
 * the credential predicate and a copy of it would be a second thing to keep
 * correct. The default stays `FOR SHARE`: a read must not block a writer longer
 * than it must.
 *
 * `03E` passes `'update'`, and that is not an optimization — it is what keeps the
 * decide path deadlock-free. The ledger engine locks the version `FOR UPDATE`
 * itself; if the portal had first taken `FOR SHARE` on the same row, two PIC
 * sessions deciding concurrently would each hold a shared lock and each try to
 * upgrade, which Postgres resolves by aborting one of them with `40P01` — a 500
 * on an endpoint whose contract is 201/401/404/409. Taking the exclusive lock once,
 * through the credential predicate, means the engine's re-lock is already held.
 */
export async function findVersionForCredential(
  tx: PoolClient,
  principal: PicWorkspacePrincipal,
  quotationVersionId: string,
  options: { lock?: 'share' | 'update' } = {},
): Promise<PicPortalVersionRow | null> {
  const result = await tx.query<Record<string, unknown>>(
    `SELECT v.id AS version_id, v.quotation_id, q.handyman_request_id,
            r.client_id, r.tenant_company_id, r.building_id, r.space_id,
            r.tenant_pic_id, r.status AS request_status,
            r.service_catalog_id, r.service_variant_id, r.description,
            v.version_number, v.status AS version_status, v.valid_until,
            v.created_by_user_id AS version_author, q.created_by_user_id AS root_author
       FROM handyman_quotation_versions v
       JOIN handyman_quotations q ON q.id = v.quotation_id
       JOIN handyman_service_requests r ON r.id = q.handyman_request_id
      WHERE v.id = ${UUID_CAST('$1')}
        AND r.tenant_company_id = ${UUID_CAST('$2')}
        AND r.building_id = ${UUID_CAST('$3')}
        AND ($4::uuid IS NULL OR r.space_id = $4::uuid)
      FOR ${options.lock === 'update' ? 'UPDATE' : 'SHARE'} OF v`,
    [quotationVersionId, principal.tenantCompanyId, principal.buildingId,
      principal.spaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    quotationVersionId: String(row.version_id),
    quotationId: String(row.quotation_id),
    handymanRequestId: String(row.handyman_request_id),
    clientId: String(row.client_id),
    tenantCompanyId: String(row.tenant_company_id),
    buildingId: String(row.building_id),
    spaceId: row.space_id ? String(row.space_id) : null,
    lineageTenantPicId: row.tenant_pic_id ? String(row.tenant_pic_id) : null,
    requestStatus: String(row.request_status),
    serviceCatalogId: String(row.service_catalog_id),
    serviceVariantId: row.service_variant_id ? String(row.service_variant_id) : null,
    description: row.description === null || row.description === undefined
      ? null
      : String(row.description),
    versionNumber: Number(row.version_number),
    status: String(row.version_status),
    validUntil: (row.valid_until as Date) ?? null,
    quotationAuthorUserId: String(row.root_author),
    versionAuthorUserId: String(row.version_author),
  };
}

/** B4/B16: a building-wide credential does not waive the request's own Space
 * authority. Resolve it live, never from a binding's space_authority_id, and
 * hold it through the decision transaction. These representation rows have no
 * session-revocation trigger; the actor authority → session order is unchanged. */
export async function lockCurrentRequestSpace(
  tx: PoolClient,
  version: Pick<PicPortalVersionRow, 'tenantCompanyId' | 'buildingId' | 'spaceId'>,
): Promise<boolean> {
  if (version.spaceId === null) return true;
  const result = await tx.query(
    `SELECT 1 FROM tenant_space_relationships tsr
      WHERE tsr.tenant_company_id = $1 AND tsr.building_id = $2 AND tsr.space_id = $3
        AND tsr.status = 'ACTIVE'
        AND (tsr.effective_from IS NULL OR tsr.effective_from <= clock_timestamp())
        AND (tsr.effective_until IS NULL OR tsr.effective_until >= clock_timestamp())
      FOR SHARE OF tsr`,
    [version.tenantCompanyId, version.buildingId, version.spaceId],
  );
  return result.rowCount === 1;
}

/**
 * The thread's decision on one version. `FOR SHARE` keeps the reported state
 * stable for the transaction that reads it, and the 0395/0438 ledger makes this
 * at-most-one row by construction (one authoritative decision per version).
 */
export async function findDecisionByVersion(
  tx: PoolClient,
  quotationVersionId: string,
): Promise<PicPortalDecisionRow | null> {
  const result = await tx.query<Record<string, unknown>>(
    `SELECT d.id, d.decision, d.decision_actor_type, d.decided_by_tenant_pic_id,
            d.decided_by_pic_session_id, d.approval_binding_id, d.decided_at
       FROM handyman_quotation_decisions d
      WHERE d.quotation_version_id = ${UUID_CAST('$1')}
      LIMIT 1
      FOR SHARE OF d`,
    [quotationVersionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    quotationDecisionId: String(row.id),
    decision: String(row.decision) as 'APPROVE' | 'REJECT',
    decisionActorType: String(row.decision_actor_type),
    decidedByTenantPicId: row.decided_by_tenant_pic_id
      ? String(row.decided_by_tenant_pic_id)
      : null,
    decidedByPicSessionId: row.decided_by_pic_session_id
      ? String(row.decided_by_pic_session_id)
      : null,
    approvalBindingId: row.approval_binding_id
      ? String(row.approval_binding_id)
      : null,
    decidedAt: row.decided_at as Date,
  };
}

/**
 * B16/B17 at read time, in the shape the ledger guard itself uses: keyed by
 * (tenant, building) and evaluated against `clock_timestamp()`, NEVER by trusting
 * `occupancy_authority_id`. A snapshot id is evidence of what justified a binding,
 * not cached authority — so the portal re-resolves exactly as the decide path will.
 */
export async function findCurrentOccupancyStatus(
  tx: PoolClient,
  input: { tenantCompanyId: string; buildingId: string; at: Date },
): Promise<HandymanQuotationAuthorityStatus> {
  const result = await tx.query<Record<string, unknown>>(
    `SELECT tbc.status, tbc.effective_from, tbc.effective_until
       FROM tenant_building_contexts tbc
      WHERE tbc.tenant_company_id = ${UUID_CAST('$1')}
        AND tbc.building_id = ${UUID_CAST('$2')}
      ORDER BY (tbc.status = 'ACTIVE')::int DESC, tbc.updated_at DESC NULLS LAST
      LIMIT 1`,
    [input.tenantCompanyId, input.buildingId],
  );
  const row = result.rows[0];
  if (!row) return 'MISSING';
  if (String(row.status) !== 'ACTIVE') return 'INACTIVE';
  const from = row.effective_from as Date | null;
  const until = row.effective_until as Date | null;
  const at = input.at.getTime();
  if ((from && from.getTime() > at) || (until && until.getTime() < at)) {
    return 'EXPIRED';
  }
  return 'ACTIVE';
}
