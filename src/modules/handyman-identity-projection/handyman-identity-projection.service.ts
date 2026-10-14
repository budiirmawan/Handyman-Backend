import { getPool } from '../../database';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations';

/**
 * P0-D — Canonical Identity Projection.
 *
 * Read-only join over the existing persisted authorities:
 *   Service Request → Inspection Visit → Approved Quotation → Execution Scope →
 *   Execution Visit → Assignment.
 *
 * All identities come from existing tables; no new Work Order source of truth
 * is created, and no cross-record links are fabricated. Missing seam is
 * reported as `null` with an explicit `seam` descriptor so Operations can see
 * exactly what has not yet been produced.
 */

export type CanonicalHandymanIdentityLink = {
  /** Service Request — always present when the request exists. */
  serviceRequest: {
    id: string;
    clientId: string;
    buildingId: string;
    tenantCompanyId: string;
    status: string;
    createdAt: string;
  } | null;
  /** Triage decision — recorded by CR-HM-03 PART 01. */
  triage: { id: string; disposition: string } | null;
  /** Inspection Visit appointment (PROPOSED/CONFIRMED/IN_PROGRESS/COMPLETED). */
  inspectionVisit: {
    id: string;
    state: string;
    startAt: string | null;
    endAt: string | null;
    inspectorUserId: string | null;
    /** Inspector ACTIVE assignment (P0-A). */
    inspectorAssignmentId: string | null;
  } | null;
  /** Inspection record (after on-site inspection performed). */
  inspection: { id: string; result: string } | null;
  /** Diagnosis record. */
  diagnosis: { id: string; scopeClassification: string } | null;
  /** Quotation record and approved version. */
  approvedQuotation: {
    quotationId: string;
    approvedVersionId: string;
    decisionId: string;
  } | null;
  /** Execution Scope (CR-HM-06). */
  executionScope: {
    id: string;
    status: string;
    buildingId: string;
  } | null;
  /** ACTIVE execution crew assignment (CR-HM-04). */
  executionAssignment: {
    id: string;
    providerContextId: string;
    crewId: string;
    leadUserId: string | null;
    assignedAt: string;
  } | null;
  /** Execution Visit appointment. */
  executionVisit: {
    id: string;
    state: string;
    startAt: string | null;
    endAt: string | null;
  } | null;
  /** Dispatch release (P0-C). */
  dispatchRelease: {
    id: string;
    status: string;
    releasedAt: string;
  } | null;
  /** Open work session (CR-HM-08) if any. */
  workSession: { id: string; status: string; checkedInAt: string | null } | null;
  /** Seams absent — reported verbatim rather than silently fabricated. */
  missingSeams: string[];
};

export async function projectHandymanCanonicalIdentity(
  handymanRequestId: string,
  actorUserId: string,
): Promise<CanonicalHandymanIdentityLink> {
  if (!isValidUuid(handymanRequestId)) {
    throw new Error('HANDYMAN_IDENTITY_INVALID_REQUEST');
  }
  if (!isValidUuid(actorUserId)) {
    throw new Error('HANDYMAN_IDENTITY_INVALID_ACTOR');
  }
  const db = getPool();

  const request = await db.query<{
    id: string;
    client_id: string;
    building_id: string;
    tenant_company_id: string;
    status: string;
    created_at: Date;
  }>(
    `SELECT id, client_id, building_id, tenant_company_id, status, created_at
       FROM handyman_service_requests WHERE id = $1`,
    [handymanRequestId],
  );
  const row = request.rows[0];
  if (!row) {
    throw handymanExecutionScopeNotFoundError();
  }
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: row.client_id,
    buildingId: row.building_id,
  });

  const missingSeams: string[] = [];

  const triage = await db.query<{ id: string; triage_disposition: string }>(
    `SELECT id, triage_disposition FROM handyman_request_triage_decisions
      WHERE handyman_request_id = $1 AND client_id = $2 LIMIT 1`,
    [row.id, row.client_id],
  );
  if (!triage.rows[0]) missingSeams.push('TRIAGE');

  const inspectionVisit = await db.query<{
    id: string;
    state: string;
    start_at: Date | null;
    end_at: Date | null;
  }>(
    `SELECT id, state, start_at, end_at FROM handyman_visit_appointments
      WHERE handyman_request_id = $1 AND client_id = $2 AND kind = 'INSPECTION'
      ORDER BY created_at DESC LIMIT 1`,
    [row.id, row.client_id],
  );
  const iv = inspectionVisit.rows[0] ?? null;
  if (!iv) missingSeams.push('INSPECTION_VISIT');

  let inspectorAssignmentId: string | null = null;
  let inspectorUserId: string | null = null;
  if (iv) {
    const ia = await db.query<{
      id: string;
      inspector_user_id: string;
    }>(
      `SELECT id, inspector_user_id FROM handyman_inspector_assignments
        WHERE visit_appointment_id = $1 AND status = 'ACTIVE' LIMIT 1`,
      [iv.id],
    );
    if (ia.rows[0]) {
      inspectorAssignmentId = ia.rows[0].id;
      inspectorUserId = ia.rows[0].inspector_user_id;
    } else {
      // Fall back to the visit's originally proposed resource (when no
      // inspector assignment record exists yet).
      const vr = await db.query<{ resource_id: string }>(
        `SELECT resource_id FROM handyman_visit_appointments
          WHERE id = $1 AND resource_type = 'INSPECTOR_USER'`,
        [iv.id],
      );
      inspectorUserId = vr.rows[0]?.resource_id ?? null;
      if (!inspectorUserId) missingSeams.push('INSPECTOR_ASSIGNMENT');
    }
  }

  const inspection = await db.query<{
    id: string;
    inspection_result: string;
  }>(
    `SELECT id, inspection_result FROM handyman_request_inspections
      WHERE handyman_request_id = $1 AND client_id = $2 LIMIT 1`,
    [row.id, row.client_id],
  );
  if (!inspection.rows[0]) missingSeams.push('INSPECTION_RECORD');

  const diagnosis = await db.query<{
    id: string;
    scope_classification: string;
  }>(
    `SELECT id, scope_classification FROM handyman_request_diagnoses
      WHERE handyman_request_id = $1 AND client_id = $2 LIMIT 1`,
    [row.id, row.client_id],
  );
  if (!diagnosis.rows[0]) missingSeams.push('DIAGNOSIS');

  const scope = await db.query<{
    id: string;
    status: string;
    building_id: string;
    quotation_id: string | null;
    approved_quotation_version_id: string | null;
    quotation_decision_id: string | null;
  }>(
    `SELECT id, status, building_id, quotation_id,
            approved_quotation_version_id, quotation_decision_id
       FROM handyman_execution_scopes
      WHERE handyman_request_id = $1 AND client_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [row.id, row.client_id],
  );
  const sc = scope.rows[0] ?? null;
  if (!sc) {
    missingSeams.push('EXECUTION_SCOPE');
  }

  let approvedQuotation: CanonicalHandymanIdentityLink['approvedQuotation'] =
    null;
  if (sc && sc.quotation_id && sc.approved_quotation_version_id && sc.quotation_decision_id) {
    approvedQuotation = {
      quotationId: sc.quotation_id,
      approvedVersionId: sc.approved_quotation_version_id,
      decisionId: sc.quotation_decision_id,
    };
  } else if (sc) {
    missingSeams.push('APPROVED_QUOTATION');
  }

  let executionAssignment: CanonicalHandymanIdentityLink['executionAssignment'] =
    null;
  if (sc) {
    const asg = await db.query<{
      id: string;
      handyman_provider_context_id: string;
      handyman_crew_id: string;
      assigned_at: Date;
    }>(
      `SELECT a.id, a.handyman_provider_context_id, a.handyman_crew_id, a.assigned_at
         FROM handyman_execution_scope_assignments a
        WHERE a.execution_scope_id = $1 AND a.client_id = $2 AND a.status = 'ACTIVE'
        LIMIT 1`,
      [sc.id, row.client_id],
    );
    if (asg.rows[0]) {
      const lead = await db.query<{ user_id: string | null }>(
        `SELECT fp.user_id
           FROM handyman_work_crews c
           JOIN LATERAL (
             SELECT cl.handyman_crew_membership_id
               FROM handyman_crew_leads cl
              WHERE cl.handyman_crew_id = c.id
              ORDER BY cl.lead_seq DESC LIMIT 1
           ) lead ON TRUE
           JOIN handyman_crew_memberships cm ON cm.id = lead.handyman_crew_membership_id
             AND cm.status = 'ACTIVE'
           JOIN handyman_worker_contexts wc ON wc.id = cm.handyman_worker_context_id
             AND wc.status = 'ACTIVE'
           JOIN workforce_profiles fp ON fp.id = wc.workforce_profile_id
             AND fp.status = 'ACTIVE'
          WHERE c.id = $1
          LIMIT 1`,
        [asg.rows[0].handyman_crew_id],
      );
      executionAssignment = {
        id: asg.rows[0].id,
        providerContextId: asg.rows[0].handyman_provider_context_id,
        crewId: asg.rows[0].handyman_crew_id,
        leadUserId: lead.rows[0]?.user_id ?? null,
        assignedAt: asg.rows[0].assigned_at.toISOString(),
      };
    } else {
      missingSeams.push('EXECUTION_ASSIGNMENT');
    }
  }

  let executionVisit: CanonicalHandymanIdentityLink['executionVisit'] = null;
  if (sc) {
    const ev = await db.query<{
      id: string;
      state: string;
      start_at: Date | null;
      end_at: Date | null;
    }>(
      `SELECT id, state, start_at, end_at FROM handyman_visit_appointments
        WHERE execution_scope_id = $1 AND client_id = $2 AND kind = 'EXECUTION'
        ORDER BY created_at DESC LIMIT 1`,
      [sc.id, row.client_id],
    );
    if (ev.rows[0]) {
      executionVisit = {
        id: ev.rows[0].id,
        state: ev.rows[0].state,
        startAt: ev.rows[0].start_at ? ev.rows[0].start_at.toISOString() : null,
        endAt: ev.rows[0].end_at ? ev.rows[0].end_at.toISOString() : null,
      };
    } else {
      missingSeams.push('EXECUTION_VISIT');
    }
  }

  let dispatchRelease: CanonicalHandymanIdentityLink['dispatchRelease'] = null;
  if (sc) {
    const dr = await db.query<{
      id: string;
      status: string;
      released_at: Date;
    }>(
      `SELECT id, status, released_at FROM handyman_dispatch_releases
        WHERE execution_scope_id = $1 AND status IN ('RELEASED','IN_PROGRESS')
        LIMIT 1`,
      [sc.id],
    );
    if (dr.rows[0]) {
      dispatchRelease = {
        id: dr.rows[0].id,
        status: dr.rows[0].status,
        releasedAt: dr.rows[0].released_at.toISOString(),
      };
    }
  }

  let workSession: CanonicalHandymanIdentityLink['workSession'] = null;
  if (sc) {
    const ws = await db.query<{
      id: string;
      status: string;
      checked_in_at: Date | null;
    }>(
      `SELECT id, status, checked_in_at FROM handyman_work_sessions
        WHERE execution_scope_id = $1 AND status <> 'CHECKED_OUT'
        ORDER BY created_at DESC LIMIT 1`,
      [sc.id],
    );
    if (ws.rows[0]) {
      workSession = {
        id: ws.rows[0].id,
        status: ws.rows[0].status,
        checkedInAt: ws.rows[0].checked_in_at
          ? ws.rows[0].checked_in_at.toISOString()
          : null,
      };
    }
  }

  return {
    serviceRequest: {
      id: row.id,
      clientId: row.client_id,
      buildingId: row.building_id,
      tenantCompanyId: row.tenant_company_id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    },
    triage: triage.rows[0]
      ? { id: triage.rows[0].id, disposition: triage.rows[0].triage_disposition }
      : null,
    inspectionVisit: iv
      ? {
          id: iv.id,
          state: iv.state,
          startAt: iv.start_at ? iv.start_at.toISOString() : null,
          endAt: iv.end_at ? iv.end_at.toISOString() : null,
          inspectorUserId,
          inspectorAssignmentId,
        }
      : null,
    inspection: inspection.rows[0]
      ? { id: inspection.rows[0].id, result: inspection.rows[0].inspection_result }
      : null,
    diagnosis: diagnosis.rows[0]
      ? {
          id: diagnosis.rows[0].id,
          scopeClassification: diagnosis.rows[0].scope_classification,
        }
      : null,
    approvedQuotation,
    executionScope: sc
      ? { id: sc.id, status: sc.status, buildingId: sc.building_id }
      : null,
    executionAssignment,
    executionVisit,
    dispatchRelease,
    workSession,
    missingSeams,
  };
}

export const handymanIdentityProjectionService = {
  projectHandymanCanonicalIdentity,
};
