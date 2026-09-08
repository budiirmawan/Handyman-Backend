import { getPool } from '../../database';
import type {
  HousekeepingReportFilters,
  PublicCleaningReportRow,
  PublicComplaintReportRow,
  PublicConsumableReportRow,
  PublicFindingReportRow,
  PublicHousekeepingSummary,
  PublicInspectionReportRow,
  PublicQualityAuditReportRow,
  PublicSupervisorInspectionReportRow,
} from './housekeeping-report.types';

export async function getHousekeepingSummary(
  filters: HousekeepingReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicHousekeepingSummary> {
  const buildingId = filters.buildingId;

  // 1. Cleaning Areas count
  const areaRes = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM cleaning_areas
     WHERE building_id = $1 AND status = 'ACTIVE'`,
    [buildingId],
  );
  const cleaningAreasCount = Number(areaRes.rows[0]?.count ?? '0');

  // 2. Daily Cleaning counts
  const cleaningConds = ['gt.building_id = $1'];
  const cleaningVals: unknown[] = [buildingId];
  if (start) {
    cleaningVals.push(start);
    cleaningConds.push(`gt.occurrence_at >= $${cleaningVals.length}`);
  }
  if (end) {
    cleaningVals.push(end);
    cleaningConds.push(`gt.occurrence_at < $${cleaningVals.length}`);
  }
  if (filters.cleaningAreaId) {
    cleaningVals.push(filters.cleaningAreaId);
    cleaningConds.push(`csb.cleaning_area_id = $${cleaningVals.length}`);
  }

  const dcRes = await getPool().query<{ status: string; count: string }>(
    `SELECT gt.status, COUNT(*)::text AS count
     FROM generated_tasks gt
     JOIN cleaning_schedule_bindings csb ON csb.schedule_definition_id = gt.schedule_definition_id AND csb.status = 'ACTIVE'
     JOIN cleaning_areas ca ON ca.id = csb.cleaning_area_id AND ca.status = 'ACTIVE'
     WHERE ${cleaningConds.join(' AND ')}
     GROUP BY gt.status`,
    cleaningVals,
  );

  const dcCounts: Record<string, number> = {
    OPEN: 0,
    ASSIGNED: 0,
    IN_PROGRESS: 0,
    COMPLETED: 0,
    CANCELLED: 0,
  };
  let dcTotal = 0;
  for (const row of dcRes.rows) {
    const n = Number(row.count);
    dcCounts[row.status] = n;
    dcTotal += n;
  }

  // 3. Toilet Inspections
  const toiletBindingRes = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM toilet_inspection_bindings WHERE building_id = $1 AND status = 'ACTIVE'`,
    [buildingId],
  );
  const toiletExecRes = await getPool().query<{ total: string; completed: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE ce.status = 'COMPLETED')::text AS completed
     FROM checklist_executions ce
     JOIN toilet_inspection_bindings tib ON tib.id = ce.toilet_inspection_binding_id
     WHERE tib.building_id = $1`,
    [buildingId],
  );

  // 4. Public Area Inspections
  const paBindingRes = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM public_area_inspection_bindings WHERE building_id = $1 AND status = 'ACTIVE'`,
    [buildingId],
  );
  const paExecRes = await getPool().query<{ total: string; completed: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE ce.status = 'COMPLETED')::text AS completed
     FROM checklist_executions ce
     JOIN public_area_inspection_bindings pab ON pab.id = ce.public_area_inspection_binding_id
     WHERE pab.building_id = $1`,
    [buildingId],
  );

  // 5. Supervisor Inspections
  const supRes = await getPool().query<{ status: string; decision: string | null; count: string }>(
    `SELECT status, decision, COUNT(*)::text AS count
     FROM supervisor_inspections
     WHERE building_id = $1
     GROUP BY status, decision`,
    [buildingId],
  );
  let supTotal = 0;
  let supPending = 0;
  let supApproved = 0;
  let supRejected = 0;
  let supRework = 0;
  for (const row of supRes.rows) {
    const n = Number(row.count);
    supTotal += n;
    if (row.status === 'PENDING') supPending += n;
    if (row.decision === 'APPROVED') supApproved += n;
    if (row.decision === 'REJECTED') supRejected += n;
    if (row.decision === 'REWORK_REQUIRED') supRework += n;
  }

  // 6. Findings
  const findingRes = await getPool().query<{ status: string; count: string }>(
    `SELECT f.status, COUNT(*)::text AS count
     FROM housekeeping_finding_links hfl
     JOIN findings f ON f.id = hfl.finding_id
     WHERE hfl.building_id = $1
     GROUP BY f.status`,
    [buildingId],
  );
  let findTotal = 0;
  let findOpen = 0;
  let findInProgress = 0;
  let findRework = 0;
  let findVerified = 0;
  let findClosed = 0;
  for (const row of findingRes.rows) {
    const n = Number(row.count);
    findTotal += n;
    if (row.status === 'OPEN') findOpen += n;
    if (row.status === 'IN_PROGRESS') findInProgress += n;
    if (row.status === 'REWORK_REQUIRED') findRework += n;
    if (row.status === 'VERIFIED') findVerified += n;
    if (row.status === 'CLOSED') findClosed += n;
  }

  // 7. Consumables
  const reqRes = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM consumable_requirements WHERE building_id = $1 AND status = 'ACTIVE'`,
    [buildingId],
  );
  const readinessCountRes = await getPool().query<{ readiness_status: string; count: string }>(
    `SELECT crc.readiness_status, COUNT(*)::text AS count
     FROM consumable_requirements cr
     JOIN LATERAL (
       SELECT readiness_status FROM consumable_readiness_checks
       WHERE requirement_id = cr.id
       ORDER BY checked_at DESC LIMIT 1
     ) crc ON true
     WHERE cr.building_id = $1 AND cr.status = 'ACTIVE'
     GROUP BY crc.readiness_status`,
    [buildingId],
  );
  let readyCount = 0;
  let lowCount = 0;
  let notReadyCount = 0;
  for (const row of readinessCountRes.rows) {
    const n = Number(row.count);
    if (row.readiness_status === 'READY') readyCount += n;
    if (row.readiness_status === 'LOW') lowCount += n;
    if (row.readiness_status === 'NOT_READY') notReadyCount += n;
  }

  // 8. Quality Audits
  const qaRes = await getPool().query<{
    total: string;
    completed: string;
    passed: string;
    failed: string;
    rework: string;
    avg_score: string | null;
  }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status = 'COMPLETED')::text AS completed,
       COUNT(*) FILTER (WHERE result = 'PASS')::text AS passed,
       COUNT(*) FILTER (WHERE result = 'FAIL')::text AS failed,
       COUNT(*) FILTER (WHERE result = 'REWORK_REQUIRED')::text AS rework,
       AVG(score)::text AS avg_score
     FROM quality_audits
     WHERE building_id = $1`,
    [buildingId],
  );
  const qaRow = qaRes.rows[0];

  // 9. Complaints
  const cmpRes = await getPool().query<{ total: string; active: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status = 'ACTIVE')::text AS active
     FROM housekeeping_complaint_bindings
     WHERE building_id = $1`,
    [buildingId],
  );
  const cmpRow = cmpRes.rows[0];

  return {
    buildingId,
    dateRange: {
      dateFrom: filters.dateFrom ?? null,
      dateTo: filters.dateTo ?? null,
    },
    cleaningAreasCount,
    dailyCleaning: {
      total: dcTotal,
      open: dcCounts.OPEN,
      assigned: dcCounts.ASSIGNED,
      inProgress: dcCounts.IN_PROGRESS,
      completed: dcCounts.COMPLETED,
      cancelled: dcCounts.CANCELLED,
    },
    toiletInspections: {
      bindingsCount: Number(toiletBindingRes.rows[0]?.count ?? '0'),
      executionsCount: Number(toiletExecRes.rows[0]?.total ?? '0'),
      completedCount: Number(toiletExecRes.rows[0]?.completed ?? '0'),
    },
    publicAreaInspections: {
      bindingsCount: Number(paBindingRes.rows[0]?.count ?? '0'),
      executionsCount: Number(paExecRes.rows[0]?.total ?? '0'),
      completedCount: Number(paExecRes.rows[0]?.completed ?? '0'),
    },
    supervisorInspections: {
      total: supTotal,
      pending: supPending,
      approved: supApproved,
      rejected: supRejected,
      reworkRequired: supRework,
    },
    findings: {
      total: findTotal,
      open: findOpen,
      inProgress: findInProgress,
      reworkRequired: findRework,
      verified: findVerified,
      closed: findClosed,
    },
    consumables: {
      requirementsCount: Number(reqRes.rows[0]?.count ?? '0'),
      readyCount,
      lowCount,
      notReadyCount,
    },
    qualityAudits: {
      total: Number(qaRow?.total ?? '0'),
      completed: Number(qaRow?.completed ?? '0'),
      passed: Number(qaRow?.passed ?? '0'),
      failed: Number(qaRow?.failed ?? '0'),
      reworkRequired: Number(qaRow?.rework ?? '0'),
      averageScore: qaRow?.avg_score ? Math.round(Number(qaRow.avg_score) * 10) / 10 : null,
    },
    complaints: {
      totalBindings: Number(cmpRow?.total ?? '0'),
      activeBindings: Number(cmpRow?.active ?? '0'),
    },
  };
}

export async function getCleaningDataset(
  filters: HousekeepingReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicCleaningReportRow[]> {
  const conditions = ['gt.building_id = $1'];
  const values: unknown[] = [filters.buildingId];

  if (start) {
    values.push(start);
    conditions.push(`gt.occurrence_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`gt.occurrence_at < $${values.length}`);
  }
  if (filters.cleaningAreaId) {
    values.push(filters.cleaningAreaId);
    conditions.push(`ca.id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`gt.status = $${values.length}`);
  }
  if (filters.workforceId) {
    values.push(filters.workforceId);
    conditions.push(`ta.workforce_profile_id = $${values.length}`);
  }
  if (filters.teamId) {
    values.push(filters.teamId);
    conditions.push(`ta.team_id = $${values.length}`);
  }

  const result = await getPool().query<{
    task_id: string;
    occurrence_at: Date;
    status: string;
    cleaning_area_id: string;
    cleaning_area_code: string;
    cleaning_area_name: string;
    cleaning_area_type: string;
    schedule_code: string;
    schedule_name: string;
    assignee_type: string | null;
    workforce_profile_id: string | null;
    team_id: string | null;
    completed_by_user_id: string | null;
    completed_at: Date | null;
  }>(
    `SELECT
       gt.id AS task_id,
       gt.occurrence_at AS occurrence_at,
       gt.status AS status,
       ca.id AS cleaning_area_id,
       ca.code AS cleaning_area_code,
       ca.name AS cleaning_area_name,
       ca.cleaning_area_type AS cleaning_area_type,
       sd.code AS schedule_code,
       sd.name AS schedule_name,
       ta.assignee_type AS assignee_type,
       ta.workforce_profile_id AS workforce_profile_id,
       ta.team_id AS team_id,
       gt.completed_by_user_id AS completed_by_user_id,
       gt.completed_at AS completed_at
     FROM generated_tasks gt
     JOIN cleaning_schedule_bindings csb ON csb.schedule_definition_id = gt.schedule_definition_id AND csb.status = 'ACTIVE'
     JOIN cleaning_areas ca ON ca.id = csb.cleaning_area_id AND ca.status = 'ACTIVE'
     JOIN schedule_definitions sd ON sd.id = gt.schedule_definition_id
     LEFT JOIN task_assignments ta ON ta.task_id = gt.id AND ta.status = 'ACTIVE'
     WHERE ${conditions.join(' AND ')}
     ORDER BY gt.occurrence_at ASC`,
    values,
  );

  return result.rows.map((row) => ({
    taskId: row.task_id,
    operationalDate: (row.occurrence_at instanceof Date ? row.occurrence_at : new Date(row.occurrence_at)).toISOString().slice(0, 10),
    occurrenceAt: (row.occurrence_at instanceof Date ? row.occurrence_at : new Date(row.occurrence_at)).toISOString(),
    status: row.status,
    cleaningAreaId: row.cleaning_area_id,
    cleaningAreaCode: row.cleaning_area_code,
    cleaningAreaName: row.cleaning_area_name,
    cleaningAreaType: row.cleaning_area_type,
    scheduleCode: row.schedule_code,
    scheduleName: row.schedule_name,
    assigneeType: row.assignee_type,
    workforceProfileId: row.workforce_profile_id,
    teamId: row.team_id,
    completedByUserId: row.completed_by_user_id,
    completedAt: row.completed_at ? (row.completed_at instanceof Date ? row.completed_at : new Date(row.completed_at)).toISOString() : null,
  }));
}

export async function getInspectionDataset(
  filters: HousekeepingReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicInspectionReportRow[]> {
  const buildingId = filters.buildingId;
  const rows: PublicInspectionReportRow[] = [];

  // Toilet inspections
  const tRes = await getPool().query<{
    binding_id: string;
    execution_id: string | null;
    execution_status: string | null;
    cleaning_area_id: string;
    cleaning_area_code: string;
    cleaning_area_name: string;
    template_code: string;
    template_name: string;
    room_code: string | null;
    functional_location_code: string | null;
    started_at: Date | null;
    completed_at: Date | null;
  }>(
    `SELECT
       tib.id AS binding_id,
       ce.id AS execution_id,
       ce.status AS execution_status,
       ca.id AS cleaning_area_id,
       ca.code AS cleaning_area_code,
       ca.name AS cleaning_area_name,
       ct.code AS template_code,
       ct.name AS template_name,
       rm.code AS room_code,
       fl.code AS functional_location_code,
       ce.started_at AS started_at,
       ce.completed_at AS completed_at
     FROM toilet_inspection_bindings tib
     JOIN cleaning_areas ca ON ca.id = tib.cleaning_area_id
     JOIN checklist_templates ct ON ct.id = tib.checklist_template_id
     LEFT JOIN checklist_executions ce ON ce.toilet_inspection_binding_id = tib.id
     LEFT JOIN rooms rm ON rm.id = tib.room_id
     LEFT JOIN functional_locations fl ON fl.id = tib.functional_location_id
     WHERE tib.building_id = $1
     ORDER BY tib.created_at DESC`,
    [buildingId],
  );

  for (const r of tRes.rows) {
    rows.push({
      inspectionType: 'TOILET',
      bindingId: r.binding_id,
      executionId: r.execution_id,
      executionStatus: r.execution_status,
      cleaningAreaId: r.cleaning_area_id,
      cleaningAreaCode: r.cleaning_area_code,
      cleaningAreaName: r.cleaning_area_name,
      templateCode: r.template_code,
      templateName: r.template_name,
      roomCode: r.room_code,
      functionalLocationCode: r.functional_location_code,
      startedAt: r.started_at ? (r.started_at instanceof Date ? r.started_at : new Date(r.started_at)).toISOString() : null,
      completedAt: r.completed_at ? (r.completed_at instanceof Date ? r.completed_at : new Date(r.completed_at)).toISOString() : null,
    });
  }

  // Public area inspections
  const paRes = await getPool().query<{
    binding_id: string;
    execution_id: string | null;
    execution_status: string | null;
    cleaning_area_id: string;
    cleaning_area_code: string;
    cleaning_area_name: string;
    template_code: string;
    template_name: string;
    room_code: string | null;
    functional_location_code: string | null;
    started_at: Date | null;
    completed_at: Date | null;
  }>(
    `SELECT
       pab.id AS binding_id,
       ce.id AS execution_id,
       ce.status AS execution_status,
       ca.id AS cleaning_area_id,
       ca.code AS cleaning_area_code,
       ca.name AS cleaning_area_name,
       ct.code AS template_code,
       ct.name AS template_name,
       rm.code AS room_code,
       fl.code AS functional_location_code,
       ce.started_at AS started_at,
       ce.completed_at AS completed_at
     FROM public_area_inspection_bindings pab
     JOIN cleaning_areas ca ON ca.id = pab.cleaning_area_id
     JOIN checklist_templates ct ON ct.id = pab.checklist_template_id
     LEFT JOIN checklist_executions ce ON ce.public_area_inspection_binding_id = pab.id
     LEFT JOIN rooms rm ON rm.id = pab.room_id
     LEFT JOIN functional_locations fl ON fl.id = pab.functional_location_id
     WHERE pab.building_id = $1
     ORDER BY pab.created_at DESC`,
    [buildingId],
  );

  for (const r of paRes.rows) {
    rows.push({
      inspectionType: 'PUBLIC_AREA',
      bindingId: r.binding_id,
      executionId: r.execution_id,
      executionStatus: r.execution_status,
      cleaningAreaId: r.cleaning_area_id,
      cleaningAreaCode: r.cleaning_area_code,
      cleaningAreaName: r.cleaning_area_name,
      templateCode: r.template_code,
      templateName: r.template_name,
      roomCode: r.room_code,
      functionalLocationCode: r.functional_location_code,
      startedAt: r.started_at ? (r.started_at instanceof Date ? r.started_at : new Date(r.started_at)).toISOString() : null,
      completedAt: r.completed_at ? (r.completed_at instanceof Date ? r.completed_at : new Date(r.completed_at)).toISOString() : null,
    });
  }

  return rows;
}

export async function getSupervisorInspectionDataset(
  filters: HousekeepingReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicSupervisorInspectionReportRow[]> {
  const conditions = ['si.building_id = $1'];
  const values: unknown[] = [filters.buildingId];

  if (start) {
    values.push(start);
    conditions.push(`si.created_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`si.created_at < $${values.length}`);
  }
  if (filters.cleaningAreaId) {
    values.push(filters.cleaningAreaId);
    conditions.push(`ca.id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`si.status = $${values.length}`);
  }

  const result = await getPool().query<{
    inspection_id: string;
    target_type: string;
    target_id: string;
    cleaning_area_id: string;
    cleaning_area_code: string;
    supervisor_user_id: string;
    decision: string | null;
    status: string;
    inspected_at: Date | null;
    notes: string | null;
  }>(
    `SELECT
       si.id AS inspection_id,
       si.target_type AS target_type,
       si.target_id AS target_id,
       ca.id AS cleaning_area_id,
       ca.code AS cleaning_area_code,
       si.supervisor_user_id AS supervisor_user_id,
       si.decision AS decision,
       si.status AS status,
       si.inspected_at AS inspected_at,
       si.notes AS notes
     FROM supervisor_inspections si
     JOIN cleaning_areas ca ON ca.id = si.cleaning_area_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY si.created_at DESC`,
    values,
  );

  return result.rows.map((r) => ({
    inspectionId: r.inspection_id,
    targetType: r.target_type,
    targetId: r.target_id,
    cleaningAreaId: r.cleaning_area_id,
    cleaningAreaCode: r.cleaning_area_code,
    supervisorUserId: r.supervisor_user_id,
    decision: r.decision,
    status: r.status,
    inspectedAt: r.inspected_at ? (r.inspected_at instanceof Date ? r.inspected_at : new Date(r.inspected_at)).toISOString() : null,
    notes: r.notes,
  }));
}

export async function getFindingDataset(
  filters: HousekeepingReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicFindingReportRow[]> {
  const conditions = ['hfl.building_id = $1'];
  const values: unknown[] = [filters.buildingId];

  if (start) {
    values.push(start);
    conditions.push(`f.reported_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`f.reported_at < $${values.length}`);
  }
  if (filters.cleaningAreaId) {
    values.push(filters.cleaningAreaId);
    conditions.push(`ca.id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`f.status = $${values.length}`);
  }

  const result = await getPool().query<{
    finding_id: string;
    finding_number: string;
    title: string;
    status: string;
    source_type: string;
    source_id: string;
    cleaning_area_id: string;
    cleaning_area_code: string;
    reported_by_user_id: string;
    reported_at: Date;
  }>(
    `SELECT
       f.id AS finding_id,
       f.finding_number AS finding_number,
       f.title AS title,
       f.status AS status,
       hfl.source_type AS source_type,
       hfl.source_id AS source_id,
       ca.id AS cleaning_area_id,
       ca.code AS cleaning_area_code,
       f.reported_by_user_id AS reported_by_user_id,
       f.reported_at AS reported_at
     FROM housekeeping_finding_links hfl
     JOIN findings f ON f.id = hfl.finding_id
     JOIN cleaning_areas ca ON ca.id = hfl.cleaning_area_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY f.reported_at DESC`,
    values,
  );

  return result.rows.map((r) => ({
    findingId: r.finding_id,
    findingNumber: r.finding_number,
    title: r.title,
    status: r.status,
    sourceType: r.source_type,
    sourceId: r.source_id,
    cleaningAreaId: r.cleaning_area_id,
    cleaningAreaCode: r.cleaning_area_code,
    reportedByUserId: r.reported_by_user_id,
    reportedAt: (r.reported_at instanceof Date ? r.reported_at : new Date(r.reported_at)).toISOString(),
  }));
}

export async function getConsumableDataset(
  filters: HousekeepingReportFilters,
): Promise<PublicConsumableReportRow[]> {
  const conditions = ['cr.building_id = $1'];
  const values: unknown[] = [filters.buildingId];

  if (filters.cleaningAreaId) {
    values.push(filters.cleaningAreaId);
    conditions.push(`cr.cleaning_area_id = $${values.length}`);
  }

  const result = await getPool().query<{
    requirement_id: string;
    requirement_code: string;
    requirement_name: string;
    unit: string;
    required_quantity: string | number;
    cleaning_area_id: string | null;
    cleaning_area_code: string | null;
    readiness_status: string | null;
    available_quantity: string | number | null;
    checked_at: Date | null;
  }>(
    `SELECT
       cr.id AS requirement_id,
       cr.code AS requirement_code,
       cr.name AS requirement_name,
       cr.unit AS unit,
       cr.required_quantity AS required_quantity,
       ca.id AS cleaning_area_id,
       ca.code AS cleaning_area_code,
       crc.readiness_status AS readiness_status,
       crc.available_quantity AS available_quantity,
       crc.checked_at AS checked_at
     FROM consumable_requirements cr
     LEFT JOIN cleaning_areas ca ON ca.id = cr.cleaning_area_id
     LEFT JOIN LATERAL (
       SELECT readiness_status, available_quantity, checked_at
       FROM consumable_readiness_checks
       WHERE requirement_id = cr.id
       ORDER BY checked_at DESC LIMIT 1
     ) crc ON true
     WHERE ${conditions.join(' AND ')}
     ORDER BY cr.code ASC`,
    values,
  );

  return result.rows.map((r) => ({
    requirementId: r.requirement_id,
    requirementCode: r.requirement_code,
    requirementName: r.requirement_name,
    unit: r.unit,
    requiredQuantity: Number(r.required_quantity),
    cleaningAreaId: r.cleaning_area_id,
    cleaningAreaCode: r.cleaning_area_code,
    readinessStatus: r.readiness_status,
    availableQuantity: r.available_quantity === null ? null : Number(r.available_quantity),
    checkedAt: r.checked_at ? (r.checked_at instanceof Date ? r.checked_at : new Date(r.checked_at)).toISOString() : null,
  }));
}

export async function getQualityAuditDataset(
  filters: HousekeepingReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicQualityAuditReportRow[]> {
  const conditions = ['qa.building_id = $1'];
  const values: unknown[] = [filters.buildingId];

  if (start) {
    values.push(start);
    conditions.push(`qa.created_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`qa.created_at < $${values.length}`);
  }
  if (filters.cleaningAreaId) {
    values.push(filters.cleaningAreaId);
    conditions.push(`ca.id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`qa.status = $${values.length}`);
  }

  const result = await getPool().query<{
    audit_id: string;
    source_type: string;
    source_id: string;
    cleaning_area_id: string | null;
    cleaning_area_code: string | null;
    auditor_user_id: string;
    score: string | number | null;
    result: string | null;
    status: string;
    audited_at: Date | null;
  }>(
    `SELECT
       qa.id AS audit_id,
       qa.source_type AS source_type,
       qa.source_id AS source_id,
       ca.id AS cleaning_area_id,
       ca.code AS cleaning_area_code,
       qa.auditor_user_id AS auditor_user_id,
       qa.score AS score,
       qa.result AS result,
       qa.status AS status,
       qa.audited_at AS audited_at
     FROM quality_audits qa
     LEFT JOIN cleaning_areas ca ON ca.id = qa.cleaning_area_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY qa.created_at DESC`,
    values,
  );

  return result.rows.map((r) => ({
    auditId: r.audit_id,
    sourceType: r.source_type,
    sourceId: r.source_id,
    cleaningAreaId: r.cleaning_area_id,
    cleaningAreaCode: r.cleaning_area_code,
    auditorUserId: r.auditor_user_id,
    score: r.score === null ? null : Number(r.score),
    result: r.result,
    status: r.status,
    auditedAt: r.audited_at ? (r.audited_at instanceof Date ? r.audited_at : new Date(r.audited_at)).toISOString() : null,
  }));
}

export async function getComplaintDataset(
  filters: HousekeepingReportFilters,
): Promise<PublicComplaintReportRow[]> {
  const conditions = ['hcb.building_id = $1'];
  const values: unknown[] = [filters.buildingId];

  if (filters.cleaningAreaId) {
    values.push(filters.cleaningAreaId);
    conditions.push(`hcb.cleaning_area_id = $${values.length}`);
  }

  const result = await getPool().query<{
    binding_id: string;
    complaint_reference: string;
    work_request_id: string | null;
    cleaning_area_id: string | null;
    cleaning_area_code: string | null;
    housekeeping_source_type: string | null;
    housekeeping_source_id: string | null;
    finding_id: string | null;
    status: string;
    created_at: Date;
  }>(
    `SELECT
       hcb.id AS binding_id,
       hcb.complaint_reference AS complaint_reference,
       hcb.work_request_id AS work_request_id,
       ca.id AS cleaning_area_id,
       ca.code AS cleaning_area_code,
       hcb.housekeeping_source_type AS housekeeping_source_type,
       hcb.housekeeping_source_id AS housekeeping_source_id,
       hcb.finding_id AS finding_id,
       hcb.status AS status,
       hcb.created_at AS created_at
     FROM housekeeping_complaint_bindings hcb
     LEFT JOIN cleaning_areas ca ON ca.id = hcb.cleaning_area_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY hcb.created_at DESC`,
    values,
  );

  return result.rows.map((r) => ({
    bindingId: r.binding_id,
    complaintReference: r.complaint_reference,
    workRequestId: r.work_request_id,
    cleaningAreaId: r.cleaning_area_id,
    cleaningAreaCode: r.cleaning_area_code,
    housekeepingSourceType: r.housekeeping_source_type,
    housekeepingSourceId: r.housekeeping_source_id,
    findingId: r.finding_id,
    status: r.status,
    createdAt: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
  }));
}

export const housekeepingReportRepository = {
  getCleaningDataset,
  getComplaintDataset,
  getConsumableDataset,
  getFindingDataset,
  getHousekeepingSummary,
  getInspectionDataset,
  getQualityAuditDataset,
  getSupervisorInspectionDataset,
};
