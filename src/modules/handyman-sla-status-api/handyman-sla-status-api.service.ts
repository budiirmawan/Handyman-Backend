/**
 * CR-HM-17 GAP PART 07 — B8 SLA & Status Visibility Customer Care Service
 * (`docs/handyman/CR-HM-17_CUSTOMER_CARE_TRANSPORT_GAP_GOVERNANCE.md` §4.7).
 *
 * Strictly read-only transport and status visibility rollup:
 *   1. `readHandymanSubjectSlaView(actorUserId, subjectType, subjectId)` —
 *      rejects non-Handyman SLA subject types (`!isHandymanSlaSubjectType`),
 *      verifies subject existence + `contextAccessService.canAccessClient`,
 *      and wraps `appliedSlaService.getBySubject(subjectId)` with the frozen
 *      9-milestone coordinate map (`HANDYMAN_SLA_SUBJECT_MILESTONES`).
 *   2. `readHandymanProviderPerformanceView(actorUserId, query)` —
 *      enforces `canAccessClient` (and building ownership when `buildingId`
 *      is supplied) and delegates directly to
 *      `deriveHandymanProviderPerformance`.
 *   3. `readHandymanRequestStatusVisibility(actorUserId, requestId)` and
 *      `readHandymanExecutionScopeStatusVisibility(actorUserId, executionScopeId)` —
 *      compose authoritative stage/status facts across `CR-HM-02..15` with
 *      the 9 frozen Handyman SLA milestones across the lineage.
 *
 * Zero writes, zero new lifecycle or SLA states, zero local breach/KPI
 * inference, zero FM work-order SLA fallback, zero provider mutation,
 * zero CR-HM-14 financial settlement, and zero SaaS fallback.
 */

import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { appliedSlaService, type PublicAppliedSla, type PublicSlaClock } from '../applied-slas';
import { isValidUuid } from '../clients';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import {
  deriveHandymanProviderPerformance,
  type HandymanProviderPerformanceSnapshot,
} from '../handyman-provider-performance';
import {
  HANDYMAN_SLA_SUBJECT_MILESTONES,
  HANDYMAN_SLA_SUBJECT_TYPES,
  isHandymanSlaSubjectType,
  type HandymanSlaMilestoneName,
  type HandymanSlaSubjectType,
} from '../sla-definitions/handyman-sla-subjects';

export type HandymanSlaClockProjection = {
  id: string;
  appliedSlaId: string;
  clockType: 'RESPONSE' | 'RESOLUTION';
  milestone: HandymanSlaMilestoneName | null;
  targetMinutes: number;
  startedAt: string;
  status: 'RUNNING' | 'SATISFIED' | 'TERMINATED';
  satisfiedAt: string | null;
  terminatedAt: string | null;
  breachedAt: string | null;
  isPaused: boolean;
  totalPausedMilliseconds: number;
  effectiveElapsedMilliseconds: number;
  pauseIntervals: PublicSlaClock['pauseIntervals'];
  createdAt: string;
  updatedAt: string;
};

export type HandymanSubjectSlaMilestoneView = {
  milestone: HandymanSlaMilestoneName;
  subjectType: HandymanSlaSubjectType;
  clockType: 'RESPONSE' | 'RESOLUTION';
  clock: HandymanSlaClockProjection | null;
};

export type HandymanSubjectSlaReadView = {
  subjectType: HandymanSlaSubjectType;
  subjectId: string;
  clientId: string;
  buildingId: string | null;
  appliedSla: {
    id: string;
    slaDefinitionId: string;
    subjectId: string;
    subjectType: HandymanSlaSubjectType;
    clientId: string;
    buildingId: string;
    definitionCode: string;
    definitionWorkType: string | null;
    definitionPriority: string | null;
    subjectWorkType: string | null;
    subjectPriority: string | null;
    responseTargetMinutes: number | null;
    resolutionTargetMinutes: number | null;
    definitionEffectiveFrom: string;
    definitionEffectiveTo: string | null;
    appliedAt: string;
    createdAt: string;
    clocks: HandymanSlaClockProjection[];
  } | null;
  milestones: HandymanSubjectSlaMilestoneView[];
};

export type HandymanLineageSlaMilestoneView = {
  milestone: HandymanSlaMilestoneName;
  subjectType: HandymanSlaSubjectType;
  clockType: 'RESPONSE' | 'RESOLUTION';
  subjectId: string | null;
  appliedSlaId: string | null;
  definitionCode: string | null;
  clock: HandymanSlaClockProjection | null;
};

export type HandymanStatusVisibilityReadView = {
  anchorType: 'HANDYMAN_SERVICE_REQUEST' | 'HANDYMAN_EXECUTION_SCOPE';
  clientId: string;
  buildingId: string;
  handymanRequestId: string;
  executionScopeId: string | null;
  stages: {
    request: {
      requestId: string;
      status: string;
      triageOutcome: string | null;
      diagnosisStatus: string | null;
      referralType: string | null;
    };
    readiness: {
      schedulingReadinessId: string | null;
      schedulingStatus: string | null;
      unitAccessReadinessId: string | null;
      unitAccessStatus: string | null;
      permitReadinessId: string | null;
      permitStatus: string | null;
    };
    quotation: {
      quotationId: string | null;
      latestVersionId: string | null;
      latestVersionNumber: number | null;
      latestVersionStatus: string | null;
      approvedVersionId: string | null;
    };
    executionScope: {
      executionScopeId: string | null;
      status: string | null;
    };
    assignment: {
      assignmentId: string | null;
      status: string | null;
      providerContextId: string | null;
      crewId: string | null;
    };
    arrival: {
      arrivalVerificationResultId: string | null;
      status: string | null;
      primaryReason: string | null;
    };
    workSession: {
      workSessionId: string | null;
      status: string | null;
      sessionCount: number;
    };
    materialExecution: {
      lineCount: number;
      latestStatus: string | null;
      settledLineCount: number;
    };
    qc: {
      latestQcRunId: string | null;
      latestStatus: string | null;
      evidenceRecordCount: number;
    };
    defects: {
      defectCount: number;
      openDefectCount: number;
      latestDefectId: string | null;
      latestStatus: string | null;
    };
    bast: {
      bastId: string | null;
      status: string | null;
      customerAccepted: boolean;
      warrantyStartEligible: boolean;
    };
    customerLedger: {
      transactionId: string | null;
      currency: string | null;
      chargeLineCount: number;
      confirmedPaymentCount: number;
      pendingPaymentCount: number;
    };
    serviceWarranty: {
      warrantyId: string | null;
      warrantyStatus: string | null;
      latestClaimId: string | null;
      latestClaimStatus: string | null;
      latestReworkId: string | null;
      latestReworkStatus: string | null;
      latestChargeableAdditionalWorkId: string | null;
      latestChargeableAdditionalWorkStatus: string | null;
    };
  };
  slaMilestones: HandymanLineageSlaMilestoneView[];
};

function milestoneFor(
  subjectType: HandymanSlaSubjectType,
  clockType: 'RESPONSE' | 'RESOLUTION',
): HandymanSlaMilestoneName | null {
  const found = HANDYMAN_SLA_SUBJECT_MILESTONES.find(
    (m) => m.subjectType === subjectType && m.clockType === clockType,
  );
  return found ? found.milestone : null;
}

function projectClock(
  subjectType: HandymanSlaSubjectType,
  c: PublicSlaClock,
): HandymanSlaClockProjection {
  return {
    id: c.id,
    appliedSlaId: c.appliedSlaId,
    clockType: c.clockType,
    milestone: milestoneFor(subjectType, c.clockType),
    targetMinutes: c.targetMinutes,
    startedAt: c.startedAt,
    status: c.status,
    satisfiedAt: c.satisfiedAt,
    terminatedAt: c.terminatedAt,
    breachedAt: c.breachedAt,
    isPaused: c.isPaused,
    totalPausedMilliseconds: c.totalPausedMilliseconds,
    effectiveElapsedMilliseconds: c.effectiveElapsedMilliseconds,
    pauseIntervals: c.pauseIntervals,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function projectAppliedSla(
  subjectType: HandymanSlaSubjectType,
  subjectId: string,
  a: PublicAppliedSla,
): NonNullable<HandymanSubjectSlaReadView['appliedSla']> {
  return {
    id: a.id,
    slaDefinitionId: a.slaDefinitionId,
    subjectId: a.subjectId ?? subjectId,
    subjectType,
    clientId: a.clientId,
    buildingId: a.buildingId,
    definitionCode: a.definitionCode,
    definitionWorkType: a.definitionWorkType,
    definitionPriority: a.definitionPriority,
    subjectWorkType: a.subjectWorkType,
    subjectPriority: a.subjectPriority,
    responseTargetMinutes: a.responseTargetMinutes,
    resolutionTargetMinutes: a.resolutionTargetMinutes,
    definitionEffectiveFrom: a.definitionEffectiveFrom,
    definitionEffectiveTo: a.definitionEffectiveTo,
    appliedAt: a.appliedAt,
    createdAt: a.createdAt,
    clocks: a.clocks.map((c) => projectClock(subjectType, c)),
  };
}

async function findDomainSubjectContext(
  subjectType: HandymanSlaSubjectType,
  subjectId: string,
): Promise<{ clientId: string; buildingId: string | null } | null> {
  const pool = getPool();
  switch (subjectType) {
    case 'HANDYMAN_SERVICE_REQUEST': {
      const r = await pool.query<{ clientId: string; buildingId: string }>(
        `SELECT client_id AS "clientId", building_id AS "buildingId"
           FROM handyman_service_requests
          WHERE id = $1`,
        [subjectId],
      );
      return r.rows[0] ?? null;
    }
    case 'HANDYMAN_EXECUTION_SCOPE': {
      const r = await pool.query<{ clientId: string; buildingId: string }>(
        `SELECT client_id AS "clientId", building_id AS "buildingId"
           FROM handyman_execution_scopes
          WHERE id = $1`,
        [subjectId],
      );
      return r.rows[0] ?? null;
    }
    case 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT': {
      const r = await pool.query<{ clientId: string; buildingId: string }>(
        `SELECT a.client_id AS "clientId", s.building_id AS "buildingId"
           FROM handyman_execution_scope_assignments a
           JOIN handyman_execution_scopes s ON s.id = a.execution_scope_id
          WHERE a.id = $1`,
        [subjectId],
      );
      return r.rows[0] ?? null;
    }
    case 'HANDYMAN_DEFECT_RECORD': {
      const r = await pool.query<{ clientId: string; buildingId: string }>(
        `SELECT d.client_id AS "clientId", s.building_id AS "buildingId"
           FROM handyman_defect_records d
           JOIN handyman_execution_scopes s ON s.id = d.execution_scope_id
          WHERE d.id = $1`,
        [subjectId],
      );
      return r.rows[0] ?? null;
    }
    case 'HANDYMAN_SERVICE_WARRANTY_CLAIM': {
      const r = await pool.query<{ clientId: string; buildingId: string }>(
        `SELECT c.client_id AS "clientId", s.building_id AS "buildingId"
           FROM handyman_service_warranty_claims c
           JOIN handyman_execution_scopes s ON s.id = c.execution_scope_id
          WHERE c.id = $1`,
        [subjectId],
      );
      return r.rows[0] ?? null;
    }
  }
}

async function assertClientReadAccess(
  actorUserId: string,
  clientId: string,
): Promise<void> {
  if (!isValidUuid(actorUserId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'actorUserId', message: 'actorUserId must be a valid UUID.' },
    ]);
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

/**
 * GET /handyman/sla/subjects/:subjectType/:subjectId
 */
export async function readHandymanSubjectSlaView(
  actorUserId: string,
  subjectTypeRaw: string,
  subjectIdRaw: string,
): Promise<HandymanSubjectSlaReadView> {
  if (!isHandymanSlaSubjectType(subjectTypeRaw)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'subjectType',
        message: `subjectType must be one of ${HANDYMAN_SLA_SUBJECT_TYPES.join(', ')}.`,
      },
    ]);
  }
  if (!isValidUuid(subjectIdRaw)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'subjectId', message: 'subjectId must be a valid UUID.' },
    ]);
  }

  const subjectType: HandymanSlaSubjectType = subjectTypeRaw;
  const subjectId = subjectIdRaw;

  const domainCtx = await findDomainSubjectContext(subjectType, subjectId);
  const applied = await appliedSlaService.getBySubject(subjectId);

  if (applied && applied.operationalType !== subjectType) {
    throw AppError.notFound('Handyman SLA subject not found.');
  }
  if (applied && applied.workOrderId !== null) {
    throw AppError.notFound('Handyman SLA subject not found.');
  }

  const clientId = domainCtx?.clientId ?? applied?.clientId ?? null;
  const buildingId = domainCtx?.buildingId ?? applied?.buildingId ?? null;
  if (!clientId) {
    throw AppError.notFound('Handyman SLA subject not found.');
  }

  await assertClientReadAccess(actorUserId, clientId);

  const projectedApplied = applied
    ? projectAppliedSla(subjectType, subjectId, applied)
    : null;

  const milestones: HandymanSubjectSlaMilestoneView[] =
    HANDYMAN_SLA_SUBJECT_MILESTONES.filter(
      (m) => m.subjectType === subjectType,
    ).map((m) => ({
      milestone: m.milestone,
      subjectType: m.subjectType,
      clockType: m.clockType,
      clock:
        projectedApplied?.clocks.find((c) => c.clockType === m.clockType) ??
        null,
    }));

  return {
    subjectType,
    subjectId,
    clientId,
    buildingId,
    appliedSla: projectedApplied,
    milestones,
  };
}

/**
 * GET /handyman/provider-performance
 */
export async function readHandymanProviderPerformanceView(
  actorUserId: string,
  query: {
    clientId?: unknown;
    buildingId?: unknown;
    from?: unknown;
    to?: unknown;
  },
): Promise<HandymanProviderPerformanceSnapshot> {
  const clientId = typeof query.clientId === 'string' ? query.clientId : '';
  if (!isValidUuid(clientId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'clientId must be a valid UUID.' },
    ]);
  }

  let buildingId: string | null = null;
  if (query.buildingId !== undefined && query.buildingId !== null && query.buildingId !== '') {
    if (typeof query.buildingId !== 'string' || !isValidUuid(query.buildingId)) {
      throw AppError.validation('Request validation failed.', [
        { field: 'buildingId', message: 'buildingId must be a valid UUID.' },
      ]);
    }
    buildingId = query.buildingId;
  }

  let from = new Date('1970-01-01T00:00:00.000Z');
  if (query.from !== undefined && query.from !== null && query.from !== '') {
    if (typeof query.from !== 'string') {
      throw AppError.validation('Request validation failed.', [
        { field: 'from', message: 'from must be an ISO-8601 timestamp.' },
      ]);
    }
    const parsedFrom = new Date(query.from);
    if (Number.isNaN(parsedFrom.getTime())) {
      throw AppError.validation('Request validation failed.', [
        { field: 'from', message: 'from must be an ISO-8601 timestamp.' },
      ]);
    }
    from = parsedFrom;
  }

  let to = new Date(Date.now() + 86_400_000);
  if (query.to !== undefined && query.to !== null && query.to !== '') {
    if (typeof query.to !== 'string') {
      throw AppError.validation('Request validation failed.', [
        { field: 'to', message: 'to must be an ISO-8601 timestamp.' },
      ]);
    }
    const parsedTo = new Date(query.to);
    if (Number.isNaN(parsedTo.getTime())) {
      throw AppError.validation('Request validation failed.', [
        { field: 'to', message: 'to must be an ISO-8601 timestamp.' },
      ]);
    }
    to = parsedTo;
  }

  if (from.getTime() >= to.getTime()) {
    throw AppError.validation('Request validation failed.', [
      { field: 'from', message: 'from must be earlier than to.' },
    ]);
  }

  await assertClientReadAccess(actorUserId, clientId);

  if (buildingId) {
    const pool = getPool();
    const b = await pool.query<{ clientId: string }>(
      `SELECT p.client_id AS "clientId"
         FROM buildings b
         JOIN properties p ON p.id = b.property_id
        WHERE b.id = $1`,
      [buildingId],
    );
    if (!b.rows[0] || b.rows[0].clientId !== clientId) {
      throw AppError.validation('Request validation failed.', [
        { field: 'buildingId', message: 'buildingId does not belong to clientId.' },
      ]);
    }
    if (!(await contextAccessService.canAccessBuilding(actorUserId, buildingId))) {
      throw buildingAccessDeniedError();
    }
  }

  return deriveHandymanProviderPerformance({
    clientId,
    buildingId,
    from,
    to,
  });
}

async function resolveBestAppliedSlaForCandidates(
  subjectType: HandymanSlaSubjectType,
  candidateIds: string[],
): Promise<{
  subjectId: string | null;
  applied: NonNullable<HandymanSubjectSlaReadView['appliedSla']> | null;
}> {
  if (candidateIds.length === 0) {
    return { subjectId: null, applied: null };
  }
  for (const id of candidateIds) {
    const found = await appliedSlaService.getBySubject(id);
    if (
      found &&
      found.operationalType === subjectType &&
      found.workOrderId === null
    ) {
      return {
        subjectId: id,
        applied: projectAppliedSla(subjectType, id, found),
      };
    }
  }
  return { subjectId: candidateIds[0], applied: null };
}

async function composeStatusVisibility(
  anchorType: 'HANDYMAN_SERVICE_REQUEST' | 'HANDYMAN_EXECUTION_SCOPE',
  requestRow: {
    id: string;
    clientId: string;
    buildingId: string;
    status: string;
  },
  scopeRow: {
    id: string;
    clientId: string;
    buildingId: string;
    status: string;
  } | null,
): Promise<HandymanStatusVisibilityReadView> {
  const pool = getPool();
  const requestId = requestRow.id;
  const executionScopeId = scopeRow?.id ?? null;

  // 1. Request stage facts (triage, diagnosis, referral)
  const [triageRes, diagnosisRes, referralRes] = await Promise.all([
    pool.query<{ outcome: string }>(
      `SELECT triage_disposition AS outcome
         FROM handyman_request_triage_decisions
        WHERE handyman_request_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [requestId],
    ),
    pool.query<{ status: string }>(
      `SELECT scope_classification AS status
         FROM handyman_request_diagnoses
        WHERE handyman_request_id = $1
        ORDER BY diagnosed_at DESC, id DESC
        LIMIT 1`,
      [requestId],
    ),
    pool.query<{ referralType: string }>(
      `SELECT referral_type AS "referralType"
         FROM handyman_request_referrals
        WHERE handyman_request_id = $1
        ORDER BY referred_at DESC, id DESC
        LIMIT 1`,
      [requestId],
    ),
  ]);

  // 2. Readiness stage facts
  const [schedRes, accessRes, permitRes] = await Promise.all([
    pool.query<{ id: string; status: string }>(
      `SELECT id, status
         FROM handyman_scheduling_readiness
        WHERE handyman_request_id = $1
        ORDER BY (status = 'ACTIVE') DESC, created_at DESC, id DESC
        LIMIT 1`,
      [requestId],
    ),
    pool.query<{ id: string; status: string }>(
      `SELECT id, status
         FROM handyman_unit_access_readiness
        WHERE handyman_request_id = $1
        ORDER BY (status = 'ACTIVE') DESC, created_at DESC, id DESC
        LIMIT 1`,
      [requestId],
    ),
    pool.query<{ id: string; status: string }>(
      `SELECT id, status
         FROM handyman_permit_readiness
        WHERE handyman_request_id = $1
        ORDER BY (status = 'ACTIVE') DESC, created_at DESC, id DESC
        LIMIT 1`,
      [requestId],
    ),
  ]);

  // 3. Quotation stage facts
  const quotationRes = await pool.query<{ id: string }>(
    `SELECT id
       FROM handyman_quotations
      WHERE handyman_request_id = $1
      LIMIT 1`,
    [requestId],
  );
  const quotationId = quotationRes.rows[0]?.id ?? null;
  let latestVersionId: string | null = null;
  let latestVersionNumber: number | null = null;
  let latestVersionStatus: string | null = null;
  let approvedVersionId: string | null = null;
  if (quotationId) {
    const versionsRes = await pool.query<{
      id: string;
      versionNumber: number;
      status: string;
    }>(
      `SELECT id, version_number AS "versionNumber", status
         FROM handyman_quotation_versions
        WHERE quotation_id = $1
        ORDER BY version_number DESC, id DESC`,
      [quotationId],
    );
    if (versionsRes.rows[0]) {
      latestVersionId = versionsRes.rows[0].id;
      latestVersionNumber = versionsRes.rows[0].versionNumber;
      latestVersionStatus = versionsRes.rows[0].status;
    }
    const approved = versionsRes.rows.find((v) => v.status === 'APPROVED');
    approvedVersionId = approved?.id ?? null;
  }

  // Execution-scope-bound stage facts
  let assignmentStage = {
    assignmentId: null as string | null,
    status: null as string | null,
    providerContextId: null as string | null,
    crewId: null as string | null,
  };
  let assignmentCandidateIds: string[] = [];

  let arrivalStage = {
    arrivalVerificationResultId: null as string | null,
    status: null as string | null,
    primaryReason: null as string | null,
  };

  let workSessionStage = {
    workSessionId: null as string | null,
    status: null as string | null,
    sessionCount: 0,
  };

  let materialExecutionStage = {
    lineCount: 0,
    latestStatus: null as string | null,
    settledLineCount: 0,
  };

  let qcStage = {
    latestQcRunId: null as string | null,
    latestStatus: null as string | null,
    evidenceRecordCount: 0,
  };

  let defectsStage = {
    defectCount: 0,
    openDefectCount: 0,
    latestDefectId: null as string | null,
    latestStatus: null as string | null,
  };
  let defectCandidateIds: string[] = [];

  let bastStage = {
    bastId: null as string | null,
    status: null as string | null,
    customerAccepted: false,
    warrantyStartEligible: false,
  };

  let customerLedgerStage = {
    transactionId: null as string | null,
    currency: null as string | null,
    chargeLineCount: 0,
    confirmedPaymentCount: 0,
    pendingPaymentCount: 0,
  };

  let serviceWarrantyStage = {
    warrantyId: null as string | null,
    warrantyStatus: null as string | null,
    latestClaimId: null as string | null,
    latestClaimStatus: null as string | null,
    latestReworkId: null as string | null,
    latestReworkStatus: null as string | null,
    latestChargeableAdditionalWorkId: null as string | null,
    latestChargeableAdditionalWorkStatus: null as string | null,
  };
  let warrantyClaimCandidateIds: string[] = [];

  if (executionScopeId) {
    const [
      assignmentsRes,
      arrivalRes,
      sessionsRes,
      materialsRes,
      qcRes,
      evidenceCountRes,
      defectsRes,
      bastRes,
      txRes,
      warrantyRes,
      claimsRes,
      reworksRes,
      chargeableRes,
    ] = await Promise.all([
      pool.query<{
        id: string;
        status: string;
        providerContextId: string;
        crewId: string;
      }>(
        `SELECT id,
                status,
                handyman_provider_context_id AS "providerContextId",
                handyman_crew_id AS "crewId"
           FROM handyman_execution_scope_assignments
          WHERE execution_scope_id = $1
          ORDER BY (status = 'ACTIVE') DESC, assigned_at DESC, id DESC`,
        [executionScopeId],
      ),
      pool.query<{ id: string; status: string; primaryReason: string }>(
        `SELECT id, status, primary_reason AS "primaryReason"
           FROM handyman_arrival_verification_results
          WHERE execution_scope_id = $1
          ORDER BY evaluated_at DESC, created_at DESC, id DESC
          LIMIT 1`,
        [executionScopeId],
      ),
      pool.query<{ id: string; status: string }>(
        `SELECT id, status
           FROM handyman_work_sessions
          WHERE execution_scope_id = $1
          ORDER BY created_at DESC, id DESC`,
        [executionScopeId],
      ),
      pool.query<{ id: string; status: string }>(
        `SELECT id, status
           FROM handyman_material_execution_lines
          WHERE execution_scope_id = $1
          ORDER BY created_at DESC, id DESC`,
        [executionScopeId],
      ),
      pool.query<{ id: string; status: string }>(
        `SELECT id, status
           FROM handyman_qc_runs
          WHERE execution_scope_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [executionScopeId],
      ),
      pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c
           FROM handyman_evidence_records
          WHERE execution_scope_id = $1`,
        [executionScopeId],
      ),
      pool.query<{ id: string; status: string }>(
        `SELECT id, status
           FROM handyman_defect_records
          WHERE execution_scope_id = $1
          ORDER BY created_at DESC, id DESC`,
        [executionScopeId],
      ),
      pool.query<{ id: string; status: string }>(
        `SELECT id, status
           FROM handyman_bast_documents
          WHERE execution_scope_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [executionScopeId],
      ),
      pool.query<{
        id: string;
        currency: string;
        chargeLineCount: number;
        confirmedPaymentCount: number;
        pendingPaymentCount: number;
      }>(
        `SELECT t.id,
                t.currency,
                (SELECT COUNT(*)::int FROM handyman_charge_lines cl WHERE cl.transaction_id = t.id) AS "chargeLineCount",
                (SELECT COUNT(*)::int FROM handyman_customer_payments p WHERE p.transaction_id = t.id AND p.status = 'CONFIRMED') AS "confirmedPaymentCount",
                (SELECT COUNT(*)::int FROM handyman_customer_payments p WHERE p.transaction_id = t.id AND p.status = 'PENDING') AS "pendingPaymentCount"
           FROM handyman_customer_transactions t
          WHERE t.execution_scope_id = $1
          LIMIT 1`,
        [executionScopeId],
      ),
      pool.query<{ id: string; status: string }>(
        `SELECT id, status
           FROM handyman_service_warranties
          WHERE execution_scope_id = $1
          LIMIT 1`,
        [executionScopeId],
      ),
      pool.query<{ id: string; status: string }>(
        `SELECT id, status
           FROM handyman_service_warranty_claims
          WHERE execution_scope_id = $1
          ORDER BY created_at DESC, id DESC`,
        [executionScopeId],
      ),
      pool.query<{ id: string; status: string }>(
        `SELECT id, status
           FROM handyman_service_warranty_reworks
          WHERE execution_scope_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [executionScopeId],
      ),
      pool.query<{ id: string; status: string }>(
        `SELECT id, status
           FROM handyman_chargeable_additional_works
          WHERE execution_scope_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [executionScopeId],
      ),
    ]);

    assignmentCandidateIds = assignmentsRes.rows.map((r) => r.id);
    if (assignmentsRes.rows[0]) {
      assignmentStage = {
        assignmentId: assignmentsRes.rows[0].id,
        status: assignmentsRes.rows[0].status,
        providerContextId: assignmentsRes.rows[0].providerContextId,
        crewId: assignmentsRes.rows[0].crewId,
      };
    }

    if (arrivalRes.rows[0]) {
      arrivalStage = {
        arrivalVerificationResultId: arrivalRes.rows[0].id,
        status: arrivalRes.rows[0].status,
        primaryReason: arrivalRes.rows[0].primaryReason,
      };
    }

    workSessionStage = {
      workSessionId: sessionsRes.rows[0]?.id ?? null,
      status: sessionsRes.rows[0]?.status ?? null,
      sessionCount: sessionsRes.rows.length,
    };

    materialExecutionStage = {
      lineCount: materialsRes.rows.length,
      latestStatus: materialsRes.rows[0]?.status ?? null,
      settledLineCount: materialsRes.rows.filter((r) => r.status === 'SETTLED')
        .length,
    };

    qcStage = {
      latestQcRunId: qcRes.rows[0]?.id ?? null,
      latestStatus: qcRes.rows[0]?.status ?? null,
      evidenceRecordCount: evidenceCountRes.rows[0]?.c ?? 0,
    };

    defectCandidateIds = defectsRes.rows.map((r) => r.id);
    defectsStage = {
      defectCount: defectsRes.rows.length,
      openDefectCount: defectsRes.rows.filter((r) => r.status !== 'VERIFIED')
        .length,
      latestDefectId: defectsRes.rows[0]?.id ?? null,
      latestStatus: defectsRes.rows[0]?.status ?? null,
    };

    if (bastRes.rows[0]) {
      const accepted = bastRes.rows[0].status === 'ACCEPTED';
      bastStage = {
        bastId: bastRes.rows[0].id,
        status: bastRes.rows[0].status,
        customerAccepted: accepted,
        warrantyStartEligible: accepted,
      };
    }

    if (txRes.rows[0]) {
      customerLedgerStage = {
        transactionId: txRes.rows[0].id,
        currency: txRes.rows[0].currency,
        chargeLineCount: txRes.rows[0].chargeLineCount,
        confirmedPaymentCount: txRes.rows[0].confirmedPaymentCount,
        pendingPaymentCount: txRes.rows[0].pendingPaymentCount,
      };
    }

    warrantyClaimCandidateIds = claimsRes.rows.map((r) => r.id);
    serviceWarrantyStage = {
      warrantyId: warrantyRes.rows[0]?.id ?? null,
      warrantyStatus: warrantyRes.rows[0]?.status ?? null,
      latestClaimId: claimsRes.rows[0]?.id ?? null,
      latestClaimStatus: claimsRes.rows[0]?.status ?? null,
      latestReworkId: reworksRes.rows[0]?.id ?? null,
      latestReworkStatus: reworksRes.rows[0]?.status ?? null,
      latestChargeableAdditionalWorkId: chargeableRes.rows[0]?.id ?? null,
      latestChargeableAdditionalWorkStatus:
        chargeableRes.rows[0]?.status ?? null,
    };
  }

  // Resolve SLA snapshots across the 5 Handyman SLA subject types in the lineage
  const [
    requestSla,
    assignmentSla,
    scopeSla,
    defectSla,
    warrantyClaimSla,
  ] = await Promise.all([
    resolveBestAppliedSlaForCandidates('HANDYMAN_SERVICE_REQUEST', [requestId]),
    resolveBestAppliedSlaForCandidates(
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
      assignmentCandidateIds,
    ),
    resolveBestAppliedSlaForCandidates(
      'HANDYMAN_EXECUTION_SCOPE',
      executionScopeId ? [executionScopeId] : [],
    ),
    resolveBestAppliedSlaForCandidates(
      'HANDYMAN_DEFECT_RECORD',
      defectCandidateIds,
    ),
    resolveBestAppliedSlaForCandidates(
      'HANDYMAN_SERVICE_WARRANTY_CLAIM',
      warrantyClaimCandidateIds,
    ),
  ]);

  const bySubjectType: Record<
    HandymanSlaSubjectType,
    {
      subjectId: string | null;
      applied: NonNullable<HandymanSubjectSlaReadView['appliedSla']> | null;
    }
  > = {
    HANDYMAN_SERVICE_REQUEST: requestSla,
    HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT: assignmentSla,
    HANDYMAN_EXECUTION_SCOPE: scopeSla,
    HANDYMAN_DEFECT_RECORD: defectSla,
    HANDYMAN_SERVICE_WARRANTY_CLAIM: warrantyClaimSla,
  };

  const slaMilestones: HandymanLineageSlaMilestoneView[] =
    HANDYMAN_SLA_SUBJECT_MILESTONES.map((m) => {
      const resolved = bySubjectType[m.subjectType];
      const clock =
        resolved.applied?.clocks.find((c) => c.clockType === m.clockType) ??
        null;
      return {
        milestone: m.milestone,
        subjectType: m.subjectType,
        clockType: m.clockType,
        subjectId: resolved.subjectId,
        appliedSlaId: resolved.applied?.id ?? null,
        definitionCode: resolved.applied?.definitionCode ?? null,
        clock,
      };
    });

  return {
    anchorType,
    clientId: requestRow.clientId,
    buildingId: scopeRow?.buildingId ?? requestRow.buildingId,
    handymanRequestId: requestId,
    executionScopeId,
    stages: {
      request: {
        requestId,
        status: requestRow.status,
        triageOutcome: triageRes.rows[0]?.outcome ?? null,
        diagnosisStatus: diagnosisRes.rows[0]?.status ?? null,
        referralType: referralRes.rows[0]?.referralType ?? null,
      },
      readiness: {
        schedulingReadinessId: schedRes.rows[0]?.id ?? null,
        schedulingStatus: schedRes.rows[0]?.status ?? null,
        unitAccessReadinessId: accessRes.rows[0]?.id ?? null,
        unitAccessStatus: accessRes.rows[0]?.status ?? null,
        permitReadinessId: permitRes.rows[0]?.id ?? null,
        permitStatus: permitRes.rows[0]?.status ?? null,
      },
      quotation: {
        quotationId,
        latestVersionId,
        latestVersionNumber,
        latestVersionStatus,
        approvedVersionId,
      },
      executionScope: {
        executionScopeId,
        status: scopeRow?.status ?? null,
      },
      assignment: assignmentStage,
      arrival: arrivalStage,
      workSession: workSessionStage,
      materialExecution: materialExecutionStage,
      qc: qcStage,
      defects: defectsStage,
      bast: bastStage,
      customerLedger: customerLedgerStage,
      serviceWarranty: serviceWarrantyStage,
    },
    slaMilestones,
  };
}

/**
 * GET /handyman/requests/:id/status-visibility
 */
export async function readHandymanRequestStatusVisibility(
  actorUserId: string,
  requestIdRaw: string,
): Promise<HandymanStatusVisibilityReadView> {
  if (!isValidUuid(requestIdRaw)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'id must be a valid UUID.' },
    ]);
  }
  const pool = getPool();
  const reqRes = await pool.query<{
    id: string;
    clientId: string;
    buildingId: string;
    status: string;
  }>(
    `SELECT id, client_id AS "clientId", building_id AS "buildingId", status
       FROM handyman_service_requests
      WHERE id = $1`,
    [requestIdRaw],
  );
  const requestRow = reqRes.rows[0];
  if (!requestRow) {
    throw AppError.notFound('Handyman service request not found.');
  }

  await assertClientReadAccess(actorUserId, requestRow.clientId);

  const scopeRes = await pool.query<{
    id: string;
    clientId: string;
    buildingId: string;
    status: string;
  }>(
    `SELECT id, client_id AS "clientId", building_id AS "buildingId", status
       FROM handyman_execution_scopes
      WHERE handyman_request_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [requestRow.id],
  );

  return composeStatusVisibility(
    'HANDYMAN_SERVICE_REQUEST',
    requestRow,
    scopeRes.rows[0] ?? null,
  );
}

/**
 * GET /handyman/execution-scopes/:id/status-visibility
 */
export async function readHandymanExecutionScopeStatusVisibility(
  actorUserId: string,
  executionScopeIdRaw: string,
): Promise<HandymanStatusVisibilityReadView> {
  if (!isValidUuid(executionScopeIdRaw)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'id must be a valid UUID.' },
    ]);
  }
  const pool = getPool();
  const scopeRes = await pool.query<{
    id: string;
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
    status: string;
  }>(
    `SELECT id,
            client_id AS "clientId",
            building_id AS "buildingId",
            handyman_request_id AS "handymanRequestId",
            status
       FROM handyman_execution_scopes
      WHERE id = $1`,
    [executionScopeIdRaw],
  );
  const scopeRow = scopeRes.rows[0];
  if (!scopeRow) {
    throw AppError.notFound('Handyman execution scope not found.');
  }

  await assertClientReadAccess(actorUserId, scopeRow.clientId);

  const reqRes = await pool.query<{
    id: string;
    clientId: string;
    buildingId: string;
    status: string;
  }>(
    `SELECT id, client_id AS "clientId", building_id AS "buildingId", status
       FROM handyman_service_requests
      WHERE id = $1`,
    [scopeRow.handymanRequestId],
  );
  const requestRow = reqRes.rows[0];
  if (!requestRow) {
    throw AppError.notFound('Handyman service request not found.');
  }

  return composeStatusVisibility(
    'HANDYMAN_EXECUTION_SCOPE',
    requestRow,
    scopeRow,
  );
}
