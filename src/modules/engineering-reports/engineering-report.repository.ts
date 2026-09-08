import { getPool } from '../../database';
import type {
  PublicBreakdownDatasetRow,
  PublicChecklistDatasetRow,
  PublicEquipmentLogDatasetRow,
  PublicFindingDatasetRow,
  PublicInspectionDatasetRow,
  PublicMaintenanceDatasetRow,
  PublicMeterReadingDatasetRow,
  PublicTechnicalSummary,
  ReportFilters,
} from './engineering-report.types';

/**
 * BE-10I — Technical Report Dataset repository.
 *
 * Direct read queries over the authoritative BE-10 / shared operational
 * records. Every dataset is a single SQL statement (no N+1, no ETL, no
 * duplicated operational tables); counts always come from the source tables
 * themselves.
 */

export type TechnicalSummaryRow = {
  scheduled_tasks: number;
  in_progress_tasks: number;
  completed_tasks: number;
  open_work_orders: number;
  completed_work_orders: number;
  open_findings: number;
  verified_findings: number;
  closed_findings: number;
  inspection_bindings: number;
  inspection_executions: number;
  meter_bindings: number;
  meter_readings: number;
  log_bindings: number;
  log_executions: number;
  checklist_bindings: number;
  checklist_executions: number;
  breakdown_open: number;
  breakdown_closed: number;
  maintenance_bindings: number;
  maintenance_work_orders: number;
};

const OPEN_FINDING_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'REWORK_REQUIRED',
  'RESUBMITTED',
];

export async function getTechnicalSummary(
  filters: ReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<TechnicalSummaryRow> {
  const result = await getPool().query<TechnicalSummaryRow>(
    `SELECT
       (SELECT count(*)::int FROM generated_tasks t
         WHERE t.building_id = $1
           AND t.status IN ('OPEN','ASSIGNED')
           AND ($2::timestamptz IS NULL OR t.occurrence_at >= $2)
           AND ($3::timestamptz IS NULL OR t.occurrence_at < $3)) AS scheduled_tasks,
       (SELECT count(*)::int FROM generated_tasks t
         WHERE t.building_id = $1 AND t.status = 'IN_PROGRESS'
           AND ($2::timestamptz IS NULL OR t.occurrence_at >= $2)
           AND ($3::timestamptz IS NULL OR t.occurrence_at < $3)) AS in_progress_tasks,
       (SELECT count(*)::int FROM generated_tasks t
         WHERE t.building_id = $1 AND t.status = 'COMPLETED'
           AND ($2::timestamptz IS NULL OR t.occurrence_at >= $2)
           AND ($3::timestamptz IS NULL OR t.occurrence_at < $3)) AS completed_tasks,
       (SELECT count(*)::int FROM work_orders w
         WHERE w.building_id = $1
           AND w.status IN ('OPEN','ASSIGNED','IN_PROGRESS','ON_HOLD')
           AND ($2::timestamptz IS NULL OR w.created_at >= $2)
           AND ($3::timestamptz IS NULL OR w.created_at < $3)) AS open_work_orders,
       (SELECT count(*)::int FROM work_orders w
         WHERE w.building_id = $1
           AND w.status IN ('COMPLETED','CLOSED')
           AND ($2::timestamptz IS NULL OR COALESCE(w.completed_at, w.closed_at) >= $2)
           AND ($3::timestamptz IS NULL OR COALESCE(w.completed_at, w.closed_at) < $3)) AS completed_work_orders,
       (SELECT count(*)::int FROM findings f
         WHERE f.building_id = $1
           AND f.status = ANY($4::text[])
           AND ($2::timestamptz IS NULL OR f.reported_at >= $2)
           AND ($3::timestamptz IS NULL OR f.reported_at < $3)) AS open_findings,
       (SELECT count(*)::int FROM findings f
         WHERE f.building_id = $1 AND f.status = 'VERIFIED'
           AND ($2::timestamptz IS NULL OR f.state_changed_at >= $2)
           AND ($3::timestamptz IS NULL OR f.state_changed_at < $3)) AS verified_findings,
       (SELECT count(*)::int FROM findings f
         WHERE f.building_id = $1 AND f.status = 'CLOSED'
           AND ($2::timestamptz IS NULL OR f.state_changed_at >= $2)
           AND ($3::timestamptz IS NULL OR f.state_changed_at < $3)) AS closed_findings,
       (SELECT count(*)::int FROM inspection_bindings ib
         WHERE ib.building_id = $1 AND ib.status = 'ACTIVE') AS inspection_bindings,
       (SELECT count(*)::int FROM checklist_executions ce
         JOIN inspection_bindings ib ON ib.id = ce.inspection_binding_id
         WHERE ib.building_id = $1
           AND ($2::timestamptz IS NULL OR ce.created_at >= $2)
           AND ($3::timestamptz IS NULL OR ce.created_at < $3)) AS inspection_executions,
       (SELECT count(*)::int FROM meter_reading_bindings mrb
         WHERE mrb.building_id = $1 AND mrb.status = 'ACTIVE') AS meter_bindings,
       (SELECT count(*)::int FROM form_instances fi
         JOIN meter_reading_bindings mrb ON mrb.id = fi.meter_reading_binding_id
         WHERE mrb.building_id = $1
           AND ($2::timestamptz IS NULL OR fi.created_at >= $2)
           AND ($3::timestamptz IS NULL OR fi.created_at < $3)) AS meter_readings,
       (SELECT count(*)::int FROM log_sheet_bindings lsb
         WHERE lsb.building_id = $1 AND lsb.status = 'ACTIVE') AS log_bindings,
       (SELECT count(*)::int FROM form_instances fi
         JOIN log_sheet_bindings lsb ON lsb.id = fi.log_sheet_binding_id
         WHERE lsb.building_id = $1
           AND ($2::timestamptz IS NULL OR fi.created_at >= $2)
           AND ($3::timestamptz IS NULL OR fi.created_at < $3)) AS log_executions,
       (SELECT count(*)::int FROM engineering_checklist_bindings ecb
         WHERE ecb.building_id = $1 AND ecb.status = 'ACTIVE') AS checklist_bindings,
       (SELECT count(*)::int FROM checklist_executions ce
         JOIN engineering_checklist_bindings ecb
           ON ecb.id = ce.engineering_checklist_binding_id
         WHERE ecb.building_id = $1
           AND ($2::timestamptz IS NULL OR ce.created_at >= $2)
           AND ($3::timestamptz IS NULL OR ce.created_at < $3)) AS checklist_executions,
       (SELECT count(*)::int FROM breakdown_bindings bb
         WHERE bb.building_id = $1 AND bb.status = 'OPEN') AS breakdown_open,
       (SELECT count(*)::int FROM breakdown_bindings bb
         WHERE bb.building_id = $1 AND bb.status = 'CLOSED') AS breakdown_closed,
       (SELECT count(*)::int FROM maintenance_bindings mb
         WHERE mb.building_id = $1 AND mb.status = 'ACTIVE') AS maintenance_bindings,
       (SELECT count(*)::int FROM maintenance_bindings mb
         WHERE mb.building_id = $1 AND mb.work_order_id IS NOT NULL) AS maintenance_work_orders`,
    [filters.buildingId, start, end, OPEN_FINDING_STATUSES],
  );
  return result.rows[0];
}

export async function getInspectionDataset(
  filters: ReportFilters,
): Promise<PublicInspectionDatasetRow[]> {
  const result = await getPool().query<PublicInspectionDatasetRow & { last_execution_at: Date | null }>(
    `SELECT
       ib.id AS "bindingId",
       ib.asset_id AS "assetId",
       a.asset_code AS "assetCode",
       a.asset_name AS "assetName",
       ct.id AS "templateId",
       ct.code AS "templateCode",
       fl.code AS "functionalLocationCode",
       ib.status,
       count(ce.id)::int AS "executionCount",
       max(ce.created_at) AS last_execution_at
     FROM inspection_bindings ib
     JOIN assets a ON a.id = ib.asset_id
     JOIN checklist_templates ct ON ct.id = ib.checklist_template_id
     LEFT JOIN functional_locations fl ON fl.id = ib.functional_location_id
     LEFT JOIN checklist_executions ce ON ce.inspection_binding_id = ib.id
     WHERE ib.building_id = $1
       AND ($2::uuid IS NULL OR ib.asset_id = $2)
       AND ($3::text IS NULL OR ib.status = $3)
     GROUP BY ib.id, a.asset_code, a.asset_name, ct.id, ct.code, fl.code
     ORDER BY ib.created_at DESC`,
    [filters.buildingId, filters.assetId ?? null, filters.status ?? null],
  );
  return result.rows.map((row) => ({
    ...row,
    lastExecutionAt: row.last_execution_at ? row.last_execution_at.toISOString() : null,
    last_execution_at: undefined as never,
  })) as unknown as PublicInspectionDatasetRow[];
}

export async function getMeterReadingDataset(
  filters: ReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicMeterReadingDatasetRow[]> {
  const result = await getPool().query<PublicMeterReadingDatasetRow & { last_read_at: Date | null }>(
    `SELECT
       mrb.id AS "bindingId",
       mrb.asset_id AS "assetId",
       a.asset_code AS "assetCode",
       a.asset_name AS "assetName",
       ff.code AS "fieldCode",
       mrb.uom_id AS "uomId",
       u.code AS "uomCode",
       u.symbol AS "uomSymbol",
       mrb.minimum_value::float8 AS "minimumValue",
       mrb.maximum_value::float8 AS "maximumValue",
       mrb.status,
       count(r.id)::int AS "readingCount",
       max(r.updated_at) AS last_read_at
     FROM meter_reading_bindings mrb
     JOIN assets a ON a.id = mrb.asset_id
     JOIN units_of_measure u ON u.id = mrb.uom_id
     LEFT JOIN form_fields ff ON ff.id = mrb.form_field_id
     LEFT JOIN form_instances fi ON fi.meter_reading_binding_id = mrb.id
     LEFT JOIN form_template_version_fields vf ON vf.field_id = mrb.form_field_id
     LEFT JOIN form_template_version_sections vs
       ON vs.id = vf.version_section_id
      AND vs.version_id = fi.form_template_version_id
     LEFT JOIN form_responses r
       ON r.form_instance_id = fi.id AND r.version_field_id = vf.id
     WHERE mrb.building_id = $1
       AND ($2::uuid IS NULL OR mrb.asset_id = $2)
       AND ($3::uuid IS NULL OR mrb.uom_id = $3)
       AND ($4::timestamptz IS NULL OR fi.created_at >= $4)
       AND ($5::timestamptz IS NULL OR fi.created_at < $5)
     GROUP BY mrb.id, a.asset_code, a.asset_name, ff.code, u.code, u.symbol
     ORDER BY mrb.created_at DESC`,
    [filters.buildingId, filters.assetId ?? null, filters.uomId ?? null, start, end],
  );
  return result.rows.map((row) => ({
    ...row,
    lastReadAt: row.last_read_at ? row.last_read_at.toISOString() : null,
    last_read_at: undefined as never,
  })) as unknown as PublicMeterReadingDatasetRow[];
}

export async function getEquipmentLogDataset(
  filters: ReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicEquipmentLogDatasetRow[]> {
  const result = await getPool().query<PublicEquipmentLogDatasetRow & { last_execution_at: Date | null }>(
    `SELECT
       lsb.id AS "bindingId",
       lsb.asset_id AS "assetId",
       a.asset_code AS "assetCode",
       a.asset_name AS "assetName",
       ft.id AS "templateId",
       ft.code AS "templateCode",
       lsb.status,
       count(fi.id)::int AS "executionCount",
       max(fi.created_at) AS last_execution_at
     FROM log_sheet_bindings lsb
     JOIN assets a ON a.id = lsb.asset_id
     JOIN form_templates ft ON ft.id = lsb.form_template_id
     LEFT JOIN form_instances fi ON fi.log_sheet_binding_id = lsb.id
     WHERE lsb.building_id = $1
       AND ($2::uuid IS NULL OR lsb.asset_id = $2)
       AND ($3::text IS NULL OR fi.status = $3)
       AND ($4::timestamptz IS NULL OR fi.created_at >= $4)
       AND ($5::timestamptz IS NULL OR fi.created_at < $5)
     GROUP BY lsb.id, a.asset_code, a.asset_name, ft.id, ft.code
     ORDER BY lsb.created_at DESC`,
    [filters.buildingId, filters.assetId ?? null, filters.status ?? null, start, end],
  );
  return result.rows.map((row) => ({
    ...row,
    lastExecutionAt: row.last_execution_at ? row.last_execution_at.toISOString() : null,
    last_execution_at: undefined as never,
  })) as unknown as PublicEquipmentLogDatasetRow[];
}

export async function getChecklistDataset(
  filters: ReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicChecklistDatasetRow[]> {
  const result = await getPool().query<PublicChecklistDatasetRow & { last_execution_at: Date | null }>(
    `SELECT
       ecb.id AS "bindingId",
       ct.id AS "templateId",
       ct.code AS "templateCode",
       ecb.asset_id AS "assetId",
       a.asset_code AS "assetCode",
       fl.code AS "functionalLocationCode",
       ecb.status AS "bindingStatus",
       count(ce.id)::int AS "executionCount",
       max(ce.created_at) AS last_execution_at
     FROM engineering_checklist_bindings ecb
     JOIN checklist_templates ct ON ct.id = ecb.checklist_template_id
     LEFT JOIN assets a ON a.id = ecb.asset_id
     LEFT JOIN functional_locations fl ON fl.id = ecb.functional_location_id
     LEFT JOIN checklist_executions ce
       ON ce.engineering_checklist_binding_id = ecb.id
     WHERE ecb.building_id = $1
       AND ($2::uuid IS NULL OR ecb.asset_id = $2)
       AND ($3::text IS NULL OR ce.status = $3)
       AND ($4::timestamptz IS NULL OR ce.created_at >= $4)
       AND ($5::timestamptz IS NULL OR ce.created_at < $5)
     GROUP BY ecb.id, ct.id, ct.code, a.asset_code, fl.code
     ORDER BY ecb.created_at DESC`,
    [filters.buildingId, filters.assetId ?? null, filters.status ?? null, start, end],
  );
  return result.rows.map((row) => ({
    ...row,
    lastExecutionAt: row.last_execution_at ? row.last_execution_at.toISOString() : null,
    last_execution_at: undefined as never,
  })) as unknown as PublicChecklistDatasetRow[];
}

export async function getBreakdownDataset(
  filters: ReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicBreakdownDatasetRow[]> {
  const result = await getPool().query<PublicBreakdownDatasetRow>(
    `SELECT
       bb.id AS "breakdownId",
       bb.asset_id AS "assetId",
       a.asset_code AS "assetCode",
       a.asset_name AS "assetName",
       bb.category,
       bb.description,
       bb.reported_by_user_id AS "reportedByUserId",
       bb.reported_at AS "reportedAt",
       bb.status,
       w.id AS "workOrderId",
       w.work_order_number AS "workOrderNumber",
       w.status AS "workOrderStatus"
     FROM breakdown_bindings bb
     JOIN assets a ON a.id = bb.asset_id
     LEFT JOIN work_orders w ON w.id = bb.work_order_id
     WHERE bb.building_id = $1
       AND ($2::uuid IS NULL OR bb.asset_id = $2)
       AND ($3::text IS NULL OR bb.status = $3)
       AND ($4::timestamptz IS NULL OR bb.reported_at >= $4)
       AND ($5::timestamptz IS NULL OR bb.reported_at < $5)
       AND ($6::uuid IS NULL OR EXISTS (
         SELECT 1 FROM work_order_assignments woa
         WHERE woa.work_order_id = bb.work_order_id
           AND woa.status = 'ACTIVE'
           AND woa.workforce_profile_id = $6))
       AND ($7::uuid IS NULL OR EXISTS (
         SELECT 1 FROM work_order_assignments woa
         WHERE woa.work_order_id = bb.work_order_id
           AND woa.status = 'ACTIVE'
           AND woa.vendor_id = $7))
     ORDER BY bb.reported_at DESC`,
    [
      filters.buildingId,
      filters.assetId ?? null,
      filters.status ?? null,
      start,
      end,
      filters.workforceId ?? null,
      filters.vendorId ?? null,
    ],
  );
  return result.rows.map((row) => ({
    ...row,
    reportedAt: (row.reportedAt as unknown as Date).toISOString(),
  }));
}

export async function getMaintenanceDataset(
  filters: ReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicMaintenanceDatasetRow[]> {
  const result = await getPool().query<PublicMaintenanceDatasetRow>(
    `SELECT
       mb.id AS "bindingId",
       mb.asset_id AS "assetId",
       a.asset_code AS "assetCode",
       a.asset_name AS "assetName",
       mb.name,
       mb.maintenance_type AS "maintenanceType",
       mb.status,
       s.code AS "scheduleCode",
       s.status AS "scheduleStatus",
       w.work_order_number AS "workOrderNumber",
       w.status AS "workOrderStatus",
       (SELECT count(*)::int FROM generated_tasks t
         WHERE t.maintenance_binding_id = mb.id
            OR (mb.schedule_definition_id IS NOT NULL
                AND t.schedule_definition_id = mb.schedule_definition_id)
       ) AS "taskCount"
     FROM maintenance_bindings mb
     JOIN assets a ON a.id = mb.asset_id
     LEFT JOIN schedule_definitions s ON s.id = mb.schedule_definition_id
     LEFT JOIN work_orders w ON w.id = mb.work_order_id
     WHERE mb.building_id = $1
       AND ($2::uuid IS NULL OR mb.asset_id = $2)
       AND ($3::text IS NULL OR mb.status = $3)
       AND ($4::timestamptz IS NULL OR mb.created_at >= $4)
       AND ($5::timestamptz IS NULL OR mb.created_at < $5)
       AND ($6::uuid IS NULL OR EXISTS (
         SELECT 1 FROM work_order_assignments woa
         WHERE woa.work_order_id = mb.work_order_id
           AND woa.status = 'ACTIVE'
           AND woa.workforce_profile_id = $6))
       AND ($7::uuid IS NULL OR EXISTS (
         SELECT 1 FROM work_order_assignments woa
         WHERE woa.work_order_id = mb.work_order_id
           AND woa.status = 'ACTIVE'
           AND woa.vendor_id = $7))
     ORDER BY mb.created_at DESC`,
    [
      filters.buildingId,
      filters.assetId ?? null,
      filters.status ?? null,
      start,
      end,
      filters.workforceId ?? null,
      filters.vendorId ?? null,
    ],
  );
  return result.rows;
}

export async function getFindingDataset(
  filters: ReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicFindingDatasetRow[]> {
  const result = await getPool().query<PublicFindingDatasetRow>(
    `SELECT
       l.id AS "linkId",
       l.finding_id AS "findingId",
       f.finding_number AS "findingNumber",
       f.title,
       f.status,
       l.operation_type AS "operationType",
       l.source_type AS "sourceType",
       l.source_id AS "sourceId",
       l.asset_id AS "assetId",
       a.asset_code AS "assetCode",
       fc.name AS "classificationName",
       fs.name AS "severityName",
       f.reported_at AS "reportedAt"
     FROM engineering_finding_links l
     JOIN findings f ON f.id = l.finding_id
     LEFT JOIN assets a ON a.id = l.asset_id
     LEFT JOIN finding_classifications fc ON fc.id = f.classification_id
     LEFT JOIN finding_severities fs ON fs.id = f.severity_id
     WHERE l.building_id = $1
       AND ($2::uuid IS NULL OR l.asset_id = $2)
       AND ($3::text IS NULL OR l.source_type = $3)
       AND ($4::text IS NULL OR f.status = $4)
       AND ($5::timestamptz IS NULL OR f.reported_at >= $5)
       AND ($6::timestamptz IS NULL OR f.reported_at < $6)
       AND ($7::uuid IS NULL OR EXISTS (
         SELECT 1 FROM finding_assignments fa
         WHERE fa.finding_id = l.finding_id
           AND fa.status = 'ACTIVE'
           AND fa.workforce_profile_id = $7))
       AND ($8::uuid IS NULL OR EXISTS (
         SELECT 1 FROM finding_assignments fa
         WHERE fa.finding_id = l.finding_id
           AND fa.status = 'ACTIVE'
           AND fa.vendor_id = $8))
     ORDER BY f.reported_at DESC`,
    [
      filters.buildingId,
      filters.assetId ?? null,
      filters.sourceType ?? null,
      filters.status ?? null,
      start,
      end,
      filters.workforceId ?? null,
      filters.vendorId ?? null,
    ],
  );
  return result.rows.map((row) => ({
    ...row,
    reportedAt: (row.reportedAt as unknown as Date).toISOString(),
  }));
}

export function toPublicTechnicalSummary(
  filters: ReportFilters,
  row: TechnicalSummaryRow,
): PublicTechnicalSummary {
  return {
    buildingId: filters.buildingId,
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    operations: {
      scheduled: row.scheduled_tasks,
      inProgress: row.in_progress_tasks,
      completed: row.completed_tasks,
      openWorkOrders: row.open_work_orders,
      openFindings: row.open_findings,
    },
    inspections: {
      bindingCount: row.inspection_bindings,
      executionCount: row.inspection_executions,
    },
    meterReadings: {
      bindingCount: row.meter_bindings,
      readingCount: row.meter_readings,
    },
    equipmentLogs: {
      bindingCount: row.log_bindings,
      executionCount: row.log_executions,
    },
    checklists: {
      bindingCount: row.checklist_bindings,
      executionCount: row.checklist_executions,
    },
    breakdowns: {
      open: row.breakdown_open,
      closed: row.breakdown_closed,
    },
    maintenance: {
      activeBindings: row.maintenance_bindings,
      linkedWorkOrders: row.maintenance_work_orders,
    },
    findings: {
      open: row.open_findings,
      verified: row.verified_findings,
      closed: row.closed_findings,
    },
  };
}

export const engineeringReportRepository = {
  getBreakdownDataset,
  getChecklistDataset,
  getEquipmentLogDataset,
  getFindingDataset,
  getInspectionDataset,
  getMaintenanceDataset,
  getMeterReadingDataset,
  getTechnicalSummary,
  toPublicTechnicalSummary,
};
