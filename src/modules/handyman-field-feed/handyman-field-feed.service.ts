import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { resolveBuildingsForUser } from '../building-assignments';
import { isValidUuid } from '../clients';
import { buildingAccessDeniedError } from '../context-access';
import { handymanInspectorAssignmentService } from '../handyman-inspector-assignments';
import { resolveHandymanAssignmentLead } from '../handyman-scope-assignments';
import { assignmentResponseRepository } from '../assignment-responses';

/**
 * Read-only field feed. The logged-in user is the identity; never accept
 * a caller-owned tenant, building, crew, request or inspector locator.
 * Current Crew Lead is derived through the append-only lead sequence, not
 * historical designation or a role string. Building access is an INNER JOIN
 * at SQL level. No unconfirmed appointment is described as a booked visit.
 */
export const MY_JOBS_SQL = `
  SELECT DISTINCT es.id AS "executionScopeId", es.handyman_request_id AS "requestId",
    es.building_id AS "buildingId", a.id AS "assignmentId", a.handyman_crew_id AS "crewId",
    COALESCE(ar.response_status, 'PENDING') AS "responseStatus",
    ar.responded_by_user_id AS "respondedByUserId",
    ar.responded_by_worker_id AS "respondedByWorkerId",
    ar.responded_at AS "respondedAt",
    ar.decline_reason AS "declineReason",
    (COALESCE(ar.response_status, 'PENDING') = 'TIDAK_BISA') AS "reassignmentRequired",
    ws.status AS "activeWorkSessionStatus",
    r.status AS "requestStatus", es.status AS "scopeStatus",
    dr.id AS "dispatchReleaseId", dr.status AS "dispatchStatus",
    dr.released_at AS "releasedAt",
    booked.id AS "confirmedAppointmentId", booked.start_at AS "confirmedStartAt",
    booked.end_at AS "confirmedEndAt", booked.timezone AS "timezone"
  FROM handyman_execution_scopes es
  JOIN handyman_service_requests r ON r.id=es.handyman_request_id AND r.client_id=es.client_id
  JOIN handyman_execution_scope_assignments a ON a.execution_scope_id=es.id
    AND a.client_id=es.client_id AND a.status='ACTIVE'
  LEFT JOIN handyman_assignment_responses ar
    ON ar.assignment_id=a.id AND ar.assignment_target_type='EXECUTION_SCOPE_ASSIGNMENT'
  LEFT JOIN LATERAL (
    SELECT ws_row.status
      FROM handyman_work_sessions ws_row
     WHERE ws_row.assignment_id = a.id
       AND ws_row.status IN ('CHECKED_IN', 'IN_PROGRESS', 'PAUSED', 'MATERIAL_RUN')
     ORDER BY ws_row.checked_in_at DESC
     LIMIT 1
  ) ws ON TRUE
  LEFT JOIN handyman_dispatch_releases dr
    ON dr.execution_scope_id=es.id AND dr.client_id=es.client_id
   AND dr.assignment_id=a.id AND dr.status IN ('RELEASED','IN_PROGRESS')
  JOIN handyman_work_crews crew ON crew.id=a.handyman_crew_id
    AND crew.client_id=es.client_id AND crew.handyman_provider_context_id=a.handyman_provider_context_id
    AND crew.status='ACTIVE'
  -- Pick the actual latest designation BEFORE evaluating eligibility.
  -- An ineligible current Lead must never resurrect a historical Lead.
  JOIN LATERAL (
    SELECT cl.handyman_crew_membership_id, cl.client_id
    FROM handyman_crew_leads cl
    WHERE cl.handyman_crew_id=crew.id
    ORDER BY cl.lead_seq DESC LIMIT 1
  ) lead ON lead.client_id=es.client_id
  JOIN handyman_crew_memberships cm ON cm.id=lead.handyman_crew_membership_id
    AND cm.handyman_crew_id=crew.id AND cm.client_id=es.client_id AND cm.status='ACTIVE'
  JOIN handyman_worker_contexts wc ON wc.id=cm.handyman_worker_context_id
    AND wc.client_id=es.client_id AND wc.handyman_provider_context_id=a.handyman_provider_context_id
    AND wc.status='ACTIVE'
  JOIN workforce_profiles fp ON fp.id=wc.workforce_profile_id AND fp.status='ACTIVE'
  JOIN users u ON u.id=fp.user_id AND u.id=$1 AND u.status='ACTIVE'
  JOIN jsonb_to_recordset($2::jsonb) AS access("buildingId" uuid, "clientId" uuid)
    ON access."buildingId"=es.building_id AND access."clientId"=es.client_id
  JOIN buildings b ON b.id=es.building_id AND b.status='ACTIVE'
  JOIN properties p ON p.id=b.property_id AND p.client_id=es.client_id
  JOIN user_building_assignments uba ON uba.user_id=$1
    AND uba.building_id=es.building_id AND uba.status='ACTIVE'
  LEFT JOIN handyman_visit_appointments booked
    ON booked.execution_scope_id=es.id AND booked.kind='EXECUTION'
      AND booked.client_id=es.client_id AND booked.handyman_request_id=es.handyman_request_id
      AND booked.building_id=es.building_id AND booked.resource_type='CREW'
      AND booked.resource_id=a.handyman_crew_id
      AND booked.state IN ('CONFIRMED','IN_PROGRESS')
  WHERE es.status='AUTHORIZED'
    AND COALESCE(ar.response_status, 'PENDING') <> 'TIDAK_BISA'
  ORDER BY booked.start_at NULLS LAST, es.id DESC
  LIMIT 100`;

export const MY_INSPECTIONS_SQL = `
  SELECT v.id AS "appointmentId", v.id AS "visitAppointmentId",
    v.handyman_request_id AS "requestId",
    v.building_id AS "buildingId", v.start_at AS "startAt", v.end_at AS "endAt",
    v.timezone, v.state, v.version,
    ia.id AS "assignmentId", ia.version AS "assignmentVersion",
    COALESCE(ar.response_status, 'PENDING') AS "responseStatus",
    ar.responded_by_user_id AS "respondedByUserId",
    ar.responded_by_worker_id AS "respondedByWorkerId",
    ar.responded_at AS "respondedAt",
    ar.decline_reason AS "declineReason",
    (COALESCE(ar.response_status, 'PENDING') = 'TIDAK_BISA') AS "reassignmentRequired"
  FROM handyman_visit_appointments v
  JOIN handyman_inspector_assignments ia
    ON ia.visit_appointment_id = v.id AND ia.status = 'ACTIVE'
  LEFT JOIN handyman_assignment_responses ar
    ON ar.assignment_id = ia.id AND ar.assignment_target_type = 'INSPECTOR_VISIT_ASSIGNMENT'
  JOIN users u ON u.id=$1 AND u.status='ACTIVE'
  JOIN jsonb_to_recordset($2::jsonb) AS access("buildingId" uuid, "clientId" uuid)
    ON access."buildingId"=v.building_id AND access."clientId"=v.client_id
  JOIN buildings b ON b.id=v.building_id AND b.status='ACTIVE'
  JOIN properties p ON p.id=b.property_id AND p.client_id=v.client_id
  JOIN user_building_assignments uba ON uba.user_id=u.id
    AND uba.building_id=v.building_id AND uba.status='ACTIVE'
  WHERE v.kind='INSPECTION' AND v.resource_type='INSPECTOR_USER'
    AND ia.inspector_user_id = u.id
    AND v.state IN ('PROPOSED','TENANT_SELECTED','CONFIRMED','IN_PROGRESS')
    AND COALESCE(ar.response_status, 'PENDING') <> 'TIDAK_BISA'
  ORDER BY v.start_at, v.id
  LIMIT 100`;

export type HandymanFieldJobAction =
  | 'TERIMA'
  | 'TIDAK_BISA'
  | 'CREATE_ARRIVAL_CHALLENGE'
  | 'CHECK_IN'
  | 'START_WORK'
  | 'PAUSE_WORK'
  | 'RESUME_WORK'
  | 'MATERIAL_RUN'
  | 'COMPLETE_WORK'
  | 'CHECK_OUT';

export type HandymanFieldInspectionAction =
  | 'TERIMA'
  | 'TIDAK_BISA'
  | 'RECORD_OUTCOME';

export function computeHandymanFieldJobAvailableActions(
  responseStatus: string | null | undefined,
  activeWorkSessionStatus?: string | null,
): HandymanFieldJobAction[] {
  const status = responseStatus ?? 'PENDING';
  if (status === 'TIDAK_BISA') {
    return [];
  }
  if (status === 'PENDING') {
    return ['TERIMA', 'TIDAK_BISA'];
  }
  if (!activeWorkSessionStatus) {
    return ['CREATE_ARRIVAL_CHALLENGE', 'CHECK_IN'];
  }
  switch (activeWorkSessionStatus) {
    case 'CHECKED_IN':
      return ['START_WORK', 'CHECK_OUT'];
    case 'IN_PROGRESS':
      return ['PAUSE_WORK', 'MATERIAL_RUN', 'COMPLETE_WORK', 'CHECK_OUT'];
    case 'PAUSED':
    case 'MATERIAL_RUN':
      return ['RESUME_WORK', 'COMPLETE_WORK', 'CHECK_OUT'];
    default:
      return [];
  }
}

export function computeHandymanFieldInspectionAvailableActions(
  responseStatus: string | null | undefined,
): HandymanFieldInspectionAction[] {
  const status = responseStatus ?? 'PENDING';
  if (status === 'TIDAK_BISA') {
    return [];
  }
  if (status === 'PENDING') {
    return ['TERIMA', 'TIDAK_BISA'];
  }
  return ['RECORD_OUTCOME'];
}

export type FieldActorRole = 'PIC_PEKERJAAN' | 'INSPECTOR';

function ensureUuidParam(value: string, fieldName: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw AppError.validation(`${fieldName} must be a valid UUID.`);
  }
  return value;
}

function fieldReadForbiddenError(): AppError {
  return new AppError({
    statusCode: 403,
    code: ERROR_CODES.HANDYMAN_FIELD_READ_FORBIDDEN,
    message:
      'User is not an authorized assigned PIC Pekerjaan or Inspector for this Work Order.',
  });
}

async function assertExactBuildingClientAccess(
  actorUserId: string,
  buildingId: string,
  clientId: string,
): Promise<void> {
  const contexts = await resolveBuildingsForUser(actorUserId);
  const allowed = contexts.some(
    (c) => c.building.id === buildingId && c.client?.id === clientId,
  );
  if (!allowed) {
    throw buildingAccessDeniedError();
  }
}

async function isAssignedInspectorForRequest(
  handymanRequestId: string,
  clientId: string,
  _buildingId: string,
  _tenantCompanyId: string,
  actorUserId: string,
): Promise<boolean> {
  return handymanInspectorAssignmentService.isActiveInspectorForRequest(
    clientId,
    handymanRequestId,
    actorUserId,
  );
}

async function resolveFieldRoleForExecutionScope(params: {
  executionScopeId: string;
  handymanRequestId: string;
  clientId: string;
  buildingId: string;
  tenantCompanyId: string;
  actorUserId: string;
}): Promise<{
  actorRole: FieldActorRole;
  leadResolution: Awaited<ReturnType<typeof resolveHandymanAssignmentLead>>;
}> {
  await assertExactBuildingClientAccess(
    params.actorUserId,
    params.buildingId,
    params.clientId,
  );

  let leadResolution: Awaited<
    ReturnType<typeof resolveHandymanAssignmentLead>
  > = null;
  try {
    leadResolution = await resolveHandymanAssignmentLead(
      params.executionScopeId,
      params.actorUserId,
    );
  } catch {
    leadResolution = null;
  }

  if (leadResolution && leadResolution.leadUserId === params.actorUserId) {
    const response = await assignmentResponseRepository.findByAssignmentId(
      leadResolution.assignmentId,
    );
    if (response?.responseStatus !== 'TIDAK_BISA') {
      return { actorRole: 'PIC_PEKERJAAN', leadResolution };
    }
  }

  const isInspector = await isAssignedInspectorForRequest(
    params.handymanRequestId,
    params.clientId,
    params.buildingId,
    params.tenantCompanyId,
    params.actorUserId,
  );
  if (isInspector) {
    return { actorRole: 'INSPECTOR', leadResolution: null };
  }

  throw fieldReadForbiddenError();
}

async function loadSanitizedQuotationSnapshot(
  quotationId: string,
  approvedQuotationVersionId: string,
) {
  const db = getPool();
  const verRes = await db.query<{
    id: string;
    quotation_id: string;
    version_number: number;
    status: string;
    valid_until: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, quotation_id, version_number, status, valid_until, created_at, updated_at
       FROM handyman_quotation_versions
      WHERE id = $1 AND quotation_id = $2`,
    [approvedQuotationVersionId, quotationId],
  );
  const version = verRes.rows[0];
  if (!version) return null;

  // Deliberately select ONLY operational scope columns (line_type, description,
  // quantity, uom, source_item_id). Privileged commercial columns
  // (reference_unit_amount, final_quoted_unit_amount, line_total, currency)
  // are never queried or returned to field actors.
  const linesRes = await db.query<{
    id: string;
    line_type: 'LABOR' | 'MATERIAL';
    description: string;
    quantity: string;
    uom_id: string;
    uom_code: string | null;
    uom_name: string | null;
    uom_symbol: string | null;
    source_item_id: string | null;
  }>(
    `SELECT ql.id,
            ql.line_type,
            ql.description,
            ql.quantity::text AS quantity,
            ql.uom_id,
            u.code AS uom_code,
            u.name AS uom_name,
            u.symbol AS uom_symbol,
            ql.source_item_id
       FROM handyman_quotation_lines ql
       LEFT JOIN units_of_measure u ON u.id = ql.uom_id
      WHERE ql.quotation_version_id = $1
      ORDER BY ql.created_at ASC, ql.id ASC`,
    [approvedQuotationVersionId],
  );

  const lines = linesRes.rows.map((row) => ({
    id: row.id,
    lineType: row.line_type,
    description: row.description,
    quantity: Number(row.quantity),
    uomId: row.uom_id,
    uomCode: row.uom_code,
    uomName: row.uom_name,
    uomSymbol: row.uom_symbol,
    sourceItemId: row.source_item_id,
  }));

  return {
    quotationId: version.quotation_id,
    versionId: version.id,
    versionNumber: version.version_number,
    status: version.status,
    validUntil: version.valid_until ? version.valid_until.toISOString() : null,
    createdAt: version.created_at.toISOString(),
    lines,
  };
}

async function loadAssignmentContext(executionScopeId: string, clientId: string) {
  const db = getPool();
  const res = await db.query<{
    assignment_id: string;
    provider_context_id: string;
    crew_id: string;
    crew_code: string;
    crew_name: string;
    status: string;
    assigned_at: Date;
    lead_worker_context_id: string | null;
    lead_user_id: string | null;
    response_status: string | null;
    responded_by_user_id: string | null;
    responded_by_worker_id: string | null;
    responded_at: Date | null;
    decline_reason: string | null;
    active_work_session_status: string | null;
  }>(
    `SELECT a.id AS assignment_id,
            a.handyman_provider_context_id AS provider_context_id,
            a.handyman_crew_id AS crew_id,
            crew.code AS crew_code,
            crew.name AS crew_name,
            a.status,
            a.assigned_at,
            wc.id AS lead_worker_context_id,
            fp.user_id AS lead_user_id,
            COALESCE(ar.response_status, 'PENDING') AS response_status,
            ar.responded_by_user_id,
            ar.responded_by_worker_id,
            ar.responded_at,
            ar.decline_reason,
            ws.status AS active_work_session_status
       FROM handyman_execution_scope_assignments a
       JOIN handyman_work_crews crew
         ON crew.id = a.handyman_crew_id
        AND crew.client_id = a.client_id
       LEFT JOIN handyman_assignment_responses ar
         ON ar.assignment_id = a.id
        AND ar.assignment_target_type = 'EXECUTION_SCOPE_ASSIGNMENT'
       LEFT JOIN LATERAL (
         SELECT ws_row.status
           FROM handyman_work_sessions ws_row
          WHERE ws_row.assignment_id = a.id
            AND ws_row.status IN ('CHECKED_IN', 'IN_PROGRESS', 'PAUSED', 'MATERIAL_RUN')
          ORDER BY ws_row.checked_in_at DESC
          LIMIT 1
       ) ws ON TRUE
       LEFT JOIN LATERAL (
         SELECT cl.handyman_crew_membership_id
           FROM handyman_crew_leads cl
          WHERE cl.handyman_crew_id = crew.id
          ORDER BY cl.lead_seq DESC
          LIMIT 1
       ) lead ON TRUE
       LEFT JOIN handyman_crew_memberships cm
         ON cm.id = lead.handyman_crew_membership_id
        AND cm.status = 'ACTIVE'
       LEFT JOIN handyman_worker_contexts wc
         ON wc.id = cm.handyman_worker_context_id
        AND wc.status = 'ACTIVE'
       LEFT JOIN workforce_profiles fp
         ON fp.id = wc.workforce_profile_id
        AND fp.status = 'ACTIVE'
      WHERE a.execution_scope_id = $1
        AND a.client_id = $2
        AND a.status = 'ACTIVE'
      LIMIT 1`,
    [executionScopeId, clientId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const responseStatus = row.response_status ?? 'PENDING';
  return {
    executionScopeId,
    assignmentId: row.assignment_id,
    providerContextId: row.provider_context_id,
    crewId: row.crew_id,
    crewCode: row.crew_code,
    crewName: row.crew_name,
    status: row.status,
    assignedAt: row.assigned_at.toISOString(),
    leadWorkerContextId: row.lead_worker_context_id,
    leadUserId: row.lead_user_id,
    responseStatus,
    respondedByUserId: row.responded_by_user_id,
    respondedByWorkerId: row.responded_by_worker_id,
    respondedAt: row.responded_at ? row.responded_at.toISOString() : null,
    declineReason: row.decline_reason,
    reassignmentRequired:
      row.status === 'ACTIVE' && responseStatus === 'TIDAK_BISA',
    activeWorkSessionStatus: row.active_work_session_status,
    availableActions: computeHandymanFieldJobAvailableActions(
      responseStatus,
      row.active_work_session_status,
    ),
  };
}

async function loadInspectorAssignmentContext(
  handymanRequestId: string,
  clientId: string,
) {
  const db = getPool();
  const res = await db.query<{
    assignment_id: string;
    visit_appointment_id: string;
    inspector_user_id: string;
    status: string;
    assigned_at: Date;
    response_status: string | null;
    responded_by_user_id: string | null;
    responded_by_worker_id: string | null;
    responded_at: Date | null;
    decline_reason: string | null;
  }>(
    `SELECT ia.id AS assignment_id,
            ia.visit_appointment_id,
            ia.inspector_user_id,
            ia.status,
            ia.assigned_at,
            COALESCE(ar.response_status, 'PENDING') AS response_status,
            ar.responded_by_user_id,
            ar.responded_by_worker_id,
            ar.responded_at,
            ar.decline_reason
       FROM handyman_inspector_assignments ia
       LEFT JOIN handyman_assignment_responses ar
         ON ar.assignment_id = ia.id
        AND ar.assignment_target_type = 'INSPECTOR_VISIT_ASSIGNMENT'
      WHERE ia.handyman_request_id = $1
        AND ia.client_id = $2
        AND ia.status = 'ACTIVE'
      ORDER BY ia.assigned_at DESC, ia.id DESC
      LIMIT 1`,
    [handymanRequestId, clientId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const responseStatus = row.response_status ?? 'PENDING';
  return {
    assignmentId: row.assignment_id,
    visitAppointmentId: row.visit_appointment_id,
    inspectorUserId: row.inspector_user_id,
    status: row.status,
    assignedAt: row.assigned_at.toISOString(),
    responseStatus,
    respondedByUserId: row.responded_by_user_id,
    respondedByWorkerId: row.responded_by_worker_id,
    respondedAt: row.responded_at ? row.responded_at.toISOString() : null,
    declineReason: row.decline_reason,
    reassignmentRequired:
      row.status === 'ACTIVE' && responseStatus === 'TIDAK_BISA',
    availableActions:
      computeHandymanFieldInspectionAvailableActions(responseStatus),
  };
}

async function loadInspectionContext(handymanRequestId: string, clientId: string) {
  const db = getPool();
  const [triageRes, inspRes, diagRes] = await Promise.all([
    db.query<{
      id: string;
      triage_disposition: string;
      triage_note: string;
      actor_user_id: string;
      created_at: Date;
    }>(
      `SELECT id, triage_disposition, triage_note, actor_user_id, created_at
         FROM handyman_request_triage_decisions
        WHERE handyman_request_id = $1 AND client_id = $2
        LIMIT 1`,
      [handymanRequestId, clientId],
    ),
    db.query<{
      id: string;
      inspection_result: string;
      inspection_notes: string;
      inspected_by_user_id: string;
      inspected_at: Date;
    }>(
      `SELECT id, inspection_result, inspection_notes, inspected_by_user_id, inspected_at
         FROM handyman_request_inspections
        WHERE handyman_request_id = $1 AND client_id = $2
        LIMIT 1`,
      [handymanRequestId, clientId],
    ),
    db.query<{
      id: string;
      handyman_discipline_id: string;
      discipline_code: string;
      diagnosis: string;
      scope_classification: string;
      recommended_service_catalog_id: string | null;
      diagnosed_by_user_id: string;
      diagnosed_at: Date;
    }>(
      `SELECT id, handyman_discipline_id, discipline_code, diagnosis,
              scope_classification, recommended_service_catalog_id,
              diagnosed_by_user_id, diagnosed_at
         FROM handyman_request_diagnoses
        WHERE handyman_request_id = $1 AND client_id = $2
        LIMIT 1`,
      [handymanRequestId, clientId],
    ),
  ]);

  const triage = triageRes.rows[0];
  const inspection = inspRes.rows[0];
  const diagnosis = diagRes.rows[0];

  return {
    triage: triage
      ? {
          id: triage.id,
          triageDisposition: triage.triage_disposition,
          triageNote: triage.triage_note,
          actorUserId: triage.actor_user_id,
          createdAt: triage.created_at.toISOString(),
        }
      : null,
    inspection: inspection
      ? {
          id: inspection.id,
          inspectionResult: inspection.inspection_result,
          inspectionNotes: inspection.inspection_notes,
          inspectedByUserId: inspection.inspected_by_user_id,
          inspectedAt: inspection.inspected_at.toISOString(),
        }
      : null,
    diagnosis: diagnosis
      ? {
          id: diagnosis.id,
          handymanDisciplineId: diagnosis.handyman_discipline_id,
          disciplineCode: diagnosis.discipline_code,
          diagnosis: diagnosis.diagnosis,
          scopeClassification: diagnosis.scope_classification,
          recommendedServiceCatalogId: diagnosis.recommended_service_catalog_id,
          diagnosedByUserId: diagnosis.diagnosed_by_user_id,
          diagnosedAt: diagnosis.diagnosed_at.toISOString(),
        }
      : null,
  };
}

async function loadVisitContext(params: {
  handymanRequestId: string;
  clientId: string;
  executionScopeId?: string | null;
}) {
  const db = getPool();
  const visitsRes = await db.query<{
    id: string;
    kind: 'INSPECTION' | 'EXECUTION';
    execution_scope_id: string | null;
    resource_type: 'INSPECTOR_USER' | 'CREW';
    resource_id: string;
    start_at: Date;
    end_at: Date;
    timezone: string;
    state: string;
    version: number;
  }>(
    `SELECT id, kind, execution_scope_id, resource_type, resource_id,
            start_at, end_at, timezone, state, version
       FROM handyman_visit_appointments
      WHERE handyman_request_id = $1
        AND client_id = $2
        AND state IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED')
      ORDER BY created_at DESC`,
    [params.handymanRequestId, params.clientId],
  );

  const mapVisit = (v: (typeof visitsRes.rows)[number] | undefined) =>
    v
      ? {
          appointmentId: v.id,
          kind: v.kind,
          executionScopeId: v.execution_scope_id,
          resourceType: v.resource_type,
          resourceId: v.resource_id,
          startAt: v.start_at.toISOString(),
          endAt: v.end_at.toISOString(),
          timezone: v.timezone,
          state: v.state,
          version: v.version,
        }
      : null;

  const inspectionVisit = visitsRes.rows.find((v) => v.kind === 'INSPECTION');
  const executionVisit = visitsRes.rows.find(
    (v) =>
      v.kind === 'EXECUTION' &&
      (!params.executionScopeId || v.execution_scope_id === params.executionScopeId),
  );

  return {
    inspectionVisit: mapVisit(inspectionVisit),
    executionVisit: mapVisit(executionVisit),
  };
}

async function loadRoleScopedMaterials(params: {
  executionScopeId: string;
  clientId: string;
  actorRole: FieldActorRole;
  quotationLines: Array<{
    id: string;
    lineType: 'LABOR' | 'MATERIAL';
    description: string;
    quantity: number;
    uomId: string;
    uomCode: string | null;
    uomName: string | null;
    uomSymbol: string | null;
    sourceItemId: string | null;
  }>;
}) {
  const quotationMaterials = params.quotationLines
    .filter((l) => l.lineType === 'MATERIAL')
    .map((l) => ({
      quotationLineId: l.id,
      description: l.description,
      approvedQuantity: l.quantity,
      uomId: l.uomId,
      uomCode: l.uomCode,
      uomName: l.uomName,
      uomSymbol: l.uomSymbol,
      sourceItemId: l.sourceItemId,
    }));

  if (params.actorRole !== 'PIC_PEKERJAAN') {
    return {
      actorRole: params.actorRole,
      quotationMaterials,
      executionLines: [],
      totalFinalUsedQty: 0,
    };
  }

  const db = getPool();
  const execLinesRes = await db.query<{
    id: string;
    quotation_version_id: string;
    quotation_line_id: string;
    source_item_id: string | null;
    status: string;
    acquisition_mode: string | null;
    estimated_qty: string;
    approved_qty: string;
    issued_qty: string;
    purchased_qty: string;
    used_qty: string;
    returned_qty: string;
    supplier_reference: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, quotation_version_id, quotation_line_id, source_item_id,
            status, acquisition_mode,
            estimated_qty::text AS estimated_qty,
            approved_qty::text AS approved_qty,
            issued_qty::text AS issued_qty,
            purchased_qty::text AS purchased_qty,
            used_qty::text AS used_qty,
            returned_qty::text AS returned_qty,
            supplier_reference, created_at, updated_at
       FROM handyman_material_execution_lines
      WHERE execution_scope_id = $1 AND client_id = $2
      ORDER BY created_at ASC, id ASC`,
    [params.executionScopeId, params.clientId],
  );

  let totalFinalUsedQty = 0;
  const executionLines = execLinesRes.rows.map((row) => {
    const usedQty = Number(row.used_qty);
    const returnedQty = Number(row.returned_qty);
    const finalUsedQty = Number((usedQty - returnedQty).toFixed(3));
    if (row.status === 'FINAL_CHARGE_READY') {
      totalFinalUsedQty = Number((totalFinalUsedQty + finalUsedQty).toFixed(3));
    }
    return {
      id: row.id,
      quotationVersionId: row.quotation_version_id,
      quotationLineId: row.quotation_line_id,
      sourceItemId: row.source_item_id,
      status: row.status,
      acquisitionMode: row.acquisition_mode,
      estimatedQty: Number(row.estimated_qty),
      approvedQty: Number(row.approved_qty),
      issuedQty: Number(row.issued_qty),
      purchasedQty: Number(row.purchased_qty),
      usedQty,
      returnedQty,
      finalUsedQty,
      supplierReference: row.supplier_reference,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });

  return {
    actorRole: params.actorRole,
    quotationMaterials,
    executionLines,
    totalFinalUsedQty,
  };
}

export async function readMyHandymanFieldFeed(actorUserId: string) {
  const db = getPool();
  // Reuse the shared authority, keeping exact Building + Client pairs (not
  // independent allowlists that could admit a cross-tenant combination).
  const contexts = await resolveBuildingsForUser(actorUserId);
  const access = JSON.stringify(
    contexts
      .filter((context) => context.client !== null)
      .map((context) => ({
        buildingId: context.building.id,
        clientId: context.client!.id,
      })),
  );
  const [jobs, inspections] = await Promise.all([
    db.query(MY_JOBS_SQL, [actorUserId, access]),
    db.query(MY_INSPECTIONS_SQL, [actorUserId, access]),
  ]);
  return {
    jobs: jobs.rows.map((row) => ({
      ...row,
      respondedAt:
        row.respondedAt instanceof Date ? row.respondedAt.toISOString() : null,
      declineReason: row.declineReason ?? null,
      reassignmentRequired: Boolean(row.reassignmentRequired),
      availableActions: computeHandymanFieldJobAvailableActions(
        row.responseStatus,
        row.activeWorkSessionStatus ?? null,
      ),
      confirmedStartAt: row.confirmedStartAt?.toISOString() ?? null,
      confirmedEndAt: row.confirmedEndAt?.toISOString() ?? null,
      releasedAt: (row as Record<string, unknown>).releasedAt
        ? (row as unknown as { releasedAt: Date }).releasedAt.toISOString()
        : null,
      appointmentConfirmed: Boolean(row.confirmedAppointmentId),
      dispatchReleased: Boolean((row as Record<string, unknown>).dispatchReleaseId),
    })),
    inspections: inspections.rows.map((row) => ({
      ...row,
      visitAppointmentId: row.visitAppointmentId ?? row.appointmentId,
      respondedAt:
        row.respondedAt instanceof Date ? row.respondedAt.toISOString() : null,
      declineReason: row.declineReason ?? null,
      reassignmentRequired: Boolean(row.reassignmentRequired),
      availableActions: computeHandymanFieldInspectionAvailableActions(
        row.responseStatus,
      ),
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
    })),
    feedSource: 'AUTHORITATIVE_BACKEND',
  };
}

/**
 * P0-A — Scoped Work Order / Execution Scope read authority for assigned
 * PIC Pekerjaan (Crew Lead) and assigned Inspector.
 */
export async function readAssignedFieldExecutionScopeDetail(
  executionScopeId: string,
  actorUserId: string,
) {
  const scopeId = ensureUuidParam(executionScopeId, 'executionScopeId');
  const db = getPool();

  const scopeRes = await db.query<{
    id: string;
    client_id: string;
    handyman_request_id: string;
    quotation_id: string;
    approved_quotation_version_id: string;
    quotation_decision_id: string;
    tenant_company_id: string;
    building_id: string;
    floor_id: string | null;
    area_id: string | null;
    room_id: string | null;
    space_id: string | null;
    status: string;
    created_at: Date;
    request_status: string;
    request_description: string | null;
    service_catalog_id: string;
    service_variant_id: string | null;
    request_created_at: Date;
    request_updated_at: Date;
  }>(
    `SELECT es.id, es.client_id, es.handyman_request_id,
            es.quotation_id, es.approved_quotation_version_id,
            es.quotation_decision_id, es.tenant_company_id,
            es.building_id, es.floor_id, es.area_id, es.room_id, es.space_id,
            es.status, es.created_at,
            r.status AS request_status,
            r.description AS request_description,
            r.service_catalog_id,
            r.service_variant_id,
            r.created_at AS request_created_at,
            r.updated_at AS request_updated_at
       FROM handyman_execution_scopes es
       JOIN handyman_service_requests r
         ON r.id = es.handyman_request_id
        AND r.client_id = es.client_id
      WHERE es.id = $1`,
    [scopeId],
  );
  const scope = scopeRes.rows[0];
  if (!scope) {
    throw new AppError({
      statusCode: 404,
      code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_NOT_FOUND,
      message: 'Handyman execution scope not found.',
    });
  }

  const { actorRole } = await resolveFieldRoleForExecutionScope({
    executionScopeId: scope.id,
    handymanRequestId: scope.handyman_request_id,
    clientId: scope.client_id,
    buildingId: scope.building_id,
    tenantCompanyId: scope.tenant_company_id,
    actorUserId,
  });

  const [approvedQuotation, assignmentContext, inspectionContext, visit] =
    await Promise.all([
      loadSanitizedQuotationSnapshot(
        scope.quotation_id,
        scope.approved_quotation_version_id,
      ),
      loadAssignmentContext(scope.id, scope.client_id),
      loadInspectionContext(scope.handyman_request_id, scope.client_id),
      loadVisitContext({
        handymanRequestId: scope.handyman_request_id,
        clientId: scope.client_id,
        executionScopeId: scope.id,
      }),
    ]);

  const materials = await loadRoleScopedMaterials({
    executionScopeId: scope.id,
    clientId: scope.client_id,
    actorRole,
    quotationLines: approvedQuotation?.lines ?? [],
  });

  return {
    actorRole,
    workOrder: {
      executionScopeId: scope.id,
      handymanRequestId: scope.handyman_request_id,
      requestStatus: scope.request_status,
      scopeStatus: scope.status,
      description: scope.request_description,
      serviceCatalogId: scope.service_catalog_id,
      serviceVariantId: scope.service_variant_id,
      tenantCompanyId: scope.tenant_company_id,
      buildingId: scope.building_id,
      floorId: scope.floor_id,
      areaId: scope.area_id,
      roomId: scope.room_id,
      spaceId: scope.space_id,
      createdAt: scope.request_created_at.toISOString(),
      updatedAt: scope.request_updated_at.toISOString(),
    },
    visit,
    executionScopeSnapshot: {
      id: scope.id,
      handymanRequestId: scope.handyman_request_id,
      quotationId: scope.quotation_id,
      approvedQuotationVersionId: scope.approved_quotation_version_id,
      quotationDecisionId: scope.quotation_decision_id,
      status: scope.status,
      approvedAt: scope.created_at.toISOString(),
    },
    approvedQuotation,
    assignmentContext,
    inspectionContext,
    materials,
  };
}

/**
 * P0-A — Scoped Request / Inspection read authority for assigned Inspector
 * (including pre-quotation inspection phase) and assigned PIC Pekerjaan.
 */
export async function readAssignedFieldRequestDetail(
  handymanRequestId: string,
  actorUserId: string,
) {
  const reqId = ensureUuidParam(handymanRequestId, 'handymanRequestId');
  const db = getPool();

  const reqRes = await db.query<{
    id: string;
    client_id: string;
    tenant_company_id: string;
    building_id: string;
    space_id: string | null;
    service_catalog_id: string;
    service_variant_id: string | null;
    description: string | null;
    status: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, client_id, tenant_company_id, building_id, space_id,
            service_catalog_id, service_variant_id, description, status,
            created_at, updated_at
       FROM handyman_service_requests
      WHERE id = $1`,
    [reqId],
  );
  const request = reqRes.rows[0];
  if (!request) {
    throw new AppError({
      statusCode: 404,
      code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_NOT_FOUND,
      message: 'Handyman service request not found.',
    });
  }

  await assertExactBuildingClientAccess(
    actorUserId,
    request.building_id,
    request.client_id,
  );

  const scopeRes = await db.query<{
    id: string;
    quotation_id: string;
    approved_quotation_version_id: string;
    quotation_decision_id: string;
    status: string;
    created_at: Date;
  }>(
    `SELECT id, quotation_id, approved_quotation_version_id,
            quotation_decision_id, status, created_at
       FROM handyman_execution_scopes
      WHERE handyman_request_id = $1 AND client_id = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [request.id, request.client_id],
  );
  const scope = scopeRes.rows[0] ?? null;

  let actorRole: FieldActorRole | null = null;
  if (scope) {
    try {
      const leadRes = await resolveHandymanAssignmentLead(
        scope.id,
        actorUserId,
      );
      if (leadRes && leadRes.leadUserId === actorUserId) {
        const response = await assignmentResponseRepository.findByAssignmentId(
          leadRes.assignmentId,
        );
        if (response?.responseStatus !== 'TIDAK_BISA') {
          actorRole = 'PIC_PEKERJAAN';
        }
      }
    } catch {
      actorRole = null;
    }
  }

  if (!actorRole) {
    const isInspector = await isAssignedInspectorForRequest(
      request.id,
      request.client_id,
      request.building_id,
      request.tenant_company_id,
      actorUserId,
    );
    if (isInspector) {
      actorRole = 'INSPECTOR';
    }
  }

  if (!actorRole) {
    throw fieldReadForbiddenError();
  }

  const [
    inspectionContext,
    visit,
    approvedQuotation,
    assignmentContext,
    inspectorAssignmentContext,
  ] = await Promise.all([
    loadInspectionContext(request.id, request.client_id),
    loadVisitContext({
      handymanRequestId: request.id,
      clientId: request.client_id,
      executionScopeId: scope?.id ?? null,
    }),
    scope
      ? loadSanitizedQuotationSnapshot(
          scope.quotation_id,
          scope.approved_quotation_version_id,
        )
      : Promise.resolve(null),
    scope
      ? loadAssignmentContext(scope.id, request.client_id)
      : Promise.resolve(null),
    loadInspectorAssignmentContext(request.id, request.client_id),
  ]);

  const materials = scope
    ? await loadRoleScopedMaterials({
        executionScopeId: scope.id,
        clientId: request.client_id,
        actorRole,
        quotationLines: approvedQuotation?.lines ?? [],
      })
    : {
        actorRole,
        quotationMaterials: [],
        executionLines: [],
        totalFinalUsedQty: 0,
      };

  return {
    actorRole,
    request: {
      handymanRequestId: request.id,
      status: request.status,
      description: request.description,
      serviceCatalogId: request.service_catalog_id,
      serviceVariantId: request.service_variant_id,
      tenantCompanyId: request.tenant_company_id,
      buildingId: request.building_id,
      spaceId: request.space_id,
      createdAt: request.created_at.toISOString(),
      updatedAt: request.updated_at.toISOString(),
    },
    visit,
    inspectionContext,
    executionScopeSnapshot: scope
      ? {
          id: scope.id,
          handymanRequestId: request.id,
          quotationId: scope.quotation_id,
          approvedQuotationVersionId: scope.approved_quotation_version_id,
          quotationDecisionId: scope.quotation_decision_id,
          status: scope.status,
          approvedAt: scope.created_at.toISOString(),
        }
      : null,
    approvedQuotation,
    assignmentContext,
    inspectorAssignmentContext,
    materials,
  };
}

/**
 * P0-A — Scoped quotation & original execution-scope snapshot read.
 */
export async function readAssignedFieldQuotationSnapshot(
  executionScopeId: string,
  actorUserId: string,
) {
  const detail = await readAssignedFieldExecutionScopeDetail(
    executionScopeId,
    actorUserId,
  );
  return {
    actorRole: detail.actorRole,
    executionScopeSnapshot: detail.executionScopeSnapshot,
    approvedQuotation: detail.approvedQuotation,
  };
}

/**
 * P0-A — Scoped material read within field actor role.
 */
export async function readAssignedFieldMaterials(
  executionScopeId: string,
  actorUserId: string,
) {
  const detail = await readAssignedFieldExecutionScopeDetail(
    executionScopeId,
    actorUserId,
  );
  return {
    executionScopeId: detail.workOrder.executionScopeId,
    actorRole: detail.actorRole,
    materials: detail.materials,
  };
}
