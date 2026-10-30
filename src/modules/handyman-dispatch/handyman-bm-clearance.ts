import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

type Executor = Pick<PoolClient, 'query'>;

/** Server-derived binding, never accepted from an HTTP request or mobile app. */
export type HandymanBmClearanceBinding = {
  protocol: 'HANDYMAN_BM_CLEARANCE_V1';
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  executionScopeId: string;
  handymanRequestId: string;
  approvedQuotationVersionId: string;
  location: { spaceId: string; roomId: string; areaId: string; floorId: string };
  assignmentId: string;
  providerContextId: string;
  crewId: string;
  leadDesignationId: string;
  leadMembershipId: string;
  leadUserId: string;
  members: Array<{
    membershipId: string; workerContextId: string; workforceProfileId: string;
    userId: string | null;
  }>;
  approvedVariations: Array<{
    id: string; variationType: string; lineType: string;
    targetQuotationLineId: string | null; revisedQuotationVersionId: string;
    description: string; quantity: string; uomId: string; authorized: boolean;
  }>;
  visit: { id: string; startAt: string; endAt: string };
  localPermit: { id: string; permitType: string; validFrom: string; validUntil: string };
  localAccess: { id: string; startAt: string; endAt: string };
};

export function handymanBmBindingDigest(binding: HandymanBmClearanceBinding): string {
  // All keys are constructed here; membership/variation arrays are sorted by ID.
  return createHash('sha256').update(JSON.stringify(binding)).digest('hex');
}

export type HandymanBmClearanceState =
  | 'NOT_INTEGRATED' | 'VERIFIED' | 'UNAVAILABLE' | 'PENDING' | 'REJECTED' | 'REVOKED'
  | 'EXPIRED' | 'BINDING_MISMATCH' | 'INVALID' | 'LOCAL_FACTS_MISSING';

export type HandymanBmClearanceAssessment = {
  state: HandymanBmClearanceState;
  bindingDigest: string | null;
  verificationReference: string | null;
};

/**
 * Optional read-only verification seam, NOT a BM approval/permit module.
 * BM handles permits/access outside Handyman. Operations records coordination
 * using existing scoped permit/access readiness services; no BM API or issuer
 * provisioning is a prerequisite for that lane. NOT_INTEGRATED is NOT a
 * verified BM decision. If an independent reader is supplied, failed/revoked/
 * stale results fail closed, never fall back to manual mode on an outage.
 * Request bodies, notes and environment flags cannot select this mode.
 */
export const handymanBmClearanceVerifier = {
  async verify(_binding: HandymanBmClearanceBinding): Promise<unknown> {
    return { decision: 'NOT_INTEGRATED' };
  },
};

/**
 * Caller holds the execution-scope lock. Crew lock excludes member inserts and
 * Lead designations; locking ALL existing memberships also excludes concurrent
 * helper activation/deactivation. Active worker/profile/user rows are held
 * through commit. No helper login is required and no billable manpower exists.
 */
export async function readBmCrewBinding(db: Executor, input: {
  clientId: string; crewId: string; providerContextId: string;
}): Promise<Pick<HandymanBmClearanceBinding,
  'providerContextId' | 'crewId' | 'leadDesignationId' | 'leadMembershipId' | 'leadUserId' | 'members'
> | null> {
  const crew = (await db.query(
    `SELECT c.id FROM handyman_work_crews c
       JOIN handyman_provider_contexts pc ON pc.id=c.handyman_provider_context_id
         AND pc.client_id=c.client_id AND pc.status='ACTIVE'
      WHERE c.id=$1 AND c.client_id=$2 AND pc.id=$3 AND c.status='ACTIVE'
      FOR SHARE OF c, pc`,
    [input.crewId, input.clientId, input.providerContextId],
  )).rows[0];
  if (!crew) return null;
  const rows = (await db.query<{
    id: string; worker_id: string; profile_id: string; user_id: string | null;
    status: string; worker_status: string; profile_status: string;
    client_id: string; worker_client_id: string; provider_id: string;
  }>(
    `SELECT m.id, m.handyman_worker_context_id AS worker_id,
            wp.id AS profile_id, wp.user_id, m.status,
            wc.status AS worker_status, wp.status AS profile_status,
            m.client_id, wc.client_id AS worker_client_id, wc.handyman_provider_context_id AS provider_id
       FROM handyman_crew_memberships m
       JOIN handyman_worker_contexts wc ON wc.id=m.handyman_worker_context_id
       JOIN workforce_profiles wp ON wp.id=wc.workforce_profile_id
      WHERE m.handyman_crew_id=$1
      ORDER BY m.id FOR SHARE OF m, wc, wp`,
    [input.crewId],
  )).rows;
  const members = rows.filter((r) => r.status === 'ACTIVE');
  if (!members.length || members.some((r) => r.worker_status !== 'ACTIVE' || r.profile_status !== 'ACTIVE' ||
    r.client_id !== input.clientId || r.worker_client_id !== input.clientId || r.provider_id !== input.providerContextId)) return null;
  const userIds = members.flatMap((r) => r.user_id ? [r.user_id] : []);
  const users = (await db.query<{ id: string; status: string }>(
    'SELECT id, status FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [userIds],
  )).rows;
  if (userIds.some((id) => !users.some((u) => u.id === id && u.status === 'ACTIVE'))) return null;
  const lead = (await db.query<{ id: string; handyman_crew_membership_id: string }>(
    `SELECT id, handyman_crew_membership_id FROM handyman_crew_leads
      WHERE handyman_crew_id=$1 ORDER BY lead_seq DESC LIMIT 1`, [input.crewId],
  )).rows[0];
  const leadMember = members.find((r) => r.id === lead?.handyman_crew_membership_id);
  if (!lead || !leadMember?.user_id) return null;
  return {
    providerContextId: input.providerContextId, crewId: input.crewId,
    leadDesignationId: lead.id, leadMembershipId: leadMember.id, leadUserId: leadMember.user_id,
    members: members.map((r) => ({ membershipId: r.id, workerContextId: r.worker_id,
      workforceProfileId: r.profile_id, userId: r.user_id })),
  };
}

/** Approved commercial revision, not request notes or a new approval engine.
 * Approval/authorization writers take the same parent scope lock. Progress,
 * QC, billing and other non-scope changes deliberately do NOT change binding.
 */
export async function readBmWorkBinding(db: Executor, scopeId: string): Promise<Pick<
  HandymanBmClearanceBinding, 'approvedQuotationVersionId' | 'tenantCompanyId' | 'approvedVariations'
>> {
  const scope = (await db.query<{ approved_quotation_version_id: string; tenant_company_id: string }>(
    `SELECT approved_quotation_version_id, tenant_company_id
       FROM handyman_execution_scopes WHERE id=$1`, [scopeId],
  )).rows[0];
  const variations = (await db.query<{
    id: string; variation_type: string; line_type: string; target_quotation_line_id: string | null;
    revised_quotation_version_id: string; description: string; quantity: string; uom_id: string; authorized: boolean;
  }>(
    `SELECT id, variation_type, line_type, target_quotation_line_id,
            revised_quotation_version_id, description, quantity::text, uom_id,
            status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY') AS authorized
       FROM handyman_scope_variations
      WHERE execution_scope_id=$1 AND tenant_decision_outcome='APPROVED'
      ORDER BY id`, [scopeId],
  )).rows;
  return {
    approvedQuotationVersionId: scope.approved_quotation_version_id,
    tenantCompanyId: scope.tenant_company_id,
    approvedVariations: variations.map((v) => ({ id: v.id, variationType: v.variation_type,
      lineType: v.line_type, targetQuotationLineId: v.target_quotation_line_id,
      revisedQuotationVersionId: v.revised_quotation_version_id, description: v.description,
      quantity: v.quantity, uomId: v.uom_id, authorized: v.authorized })),
  };
}

/** Fresh verification on EVERY new dispatch/check-in/start/resume; no cache. */
export async function assessHandymanBmClearance(
  db: Executor, binding: HandymanBmClearanceBinding,
): Promise<HandymanBmClearanceAssessment> {
  const bindingDigest = handymanBmBindingDigest(binding);
  const result = (state: HandymanBmClearanceState, reference: string | null = null) =>
    ({ state, bindingDigest, verificationReference: reference });
  let raw: unknown;
  try {
    raw = await handymanBmClearanceVerifier.verify(structuredClone(binding));
  } catch {
    return result('UNAVAILABLE');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result('INVALID');
  const fact = raw as Record<string, unknown>;
  if (fact.decision === 'NOT_INTEGRATED') {
    const now = (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    return result(Date.parse(binding.visit.endAt) <= now ? 'EXPIRED' : 'NOT_INTEGRATED');
  }
  if (fact.decision === 'UNAVAILABLE') return result('UNAVAILABLE');
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  if (fact.authority !== 'BUILDING_MANAGEMENT' || !text(fact.issuerId) ||
      !text(fact.applicabilityReference) || !text(fact.verificationReference)) return result('INVALID');
  if (fact.bindingDigest !== bindingDigest) return result('BINDING_MISMATCH');
  const timestamp = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
  const checkedAt = timestamp(fact.verifiedAt);
  const from = timestamp(fact.validFrom);
  const until = timestamp(fact.validUntil);
  // Clock AFTER verification/lock waits; transaction-start NOW is unsafe.
  const now = (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
  if (!Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > 60_000 ||
      !Number.isFinite(from) || !Number.isFinite(until) || from >= until) return result('INVALID');
  if (until <= now || Date.parse(binding.visit.endAt) <= now) return result('EXPIRED');
  if (from > Date.parse(binding.visit.startAt) || until < Date.parse(binding.visit.endAt)) return result('INVALID');
  if (fact.decision === 'PENDING' || fact.decision === 'REJECTED' || fact.decision === 'REVOKED' || fact.decision === 'EXPIRED') {
    return result(fact.decision);
  }
  if (fact.decision !== 'APPROVED') return result('INVALID');
  return result('VERIFIED', fact.verificationReference);
}
