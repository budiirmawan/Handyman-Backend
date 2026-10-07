import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  HandoverItem,
  ShiftHandoverRecord,
  ShiftHandoverStatus,
} from './shift-handover.types';

/**
 * BE-10J — Shift Handover repository.
 *
 * Holds the minimal handover records and resolves the live Engineering
 * operational dataset for a Building. Every dataset group is one SQL
 * statement over the authoritative BE-07/08/09/10 tables — operational
 * records are never copied into the handover table.
 */

type ShiftHandoverRow = {
  id: string;
  client_id: string;
  building_id: string;
  outgoing_shift_id: string;
  incoming_shift_id: string;
  handover_date: Date;
  prepared_by_user_id: string;
  acknowledged_by_user_id: string | null;
  summary: string | null;
  status: ShiftHandoverStatus;
  prepared_at: Date;
  acknowledged_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type ShiftRow = {
  id: string;
  building_id: string;
  code: string;
  name: string;
  start_time: string;
  end_time: string;
  status: string;
};

const OPEN_FINDING_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'REWORK_REQUIRED',
  'RESUBMITTED',
];

const OPEN_WORK_ORDER_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];

const INCOMPLETE_EXECUTION_STATUSES = ['DRAFT', 'IN_PROGRESS'];

const SCHEDULED_TASK_STATUSES = ['OPEN', 'ASSIGNED'];

function mapRow(row: ShiftHandoverRow): ShiftHandoverRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    outgoingShiftId: row.outgoing_shift_id,
    incomingShiftId: row.incoming_shift_id,
    handoverDate: row.handover_date.toISOString().slice(0, 10),
    preparedByUserId: row.prepared_by_user_id,
    acknowledgedByUserId: row.acknowledged_by_user_id,
    summary: row.summary,
    status: row.status,
    preparedAt: row.prepared_at,
    acknowledgedAt: row.acknowledged_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: {
    clientId: string;
    buildingId: string;
    outgoingShiftId: string;
    incomingShiftId: string;
    handoverDate: string;
    summary: string | null;
    preparedByUserId: string;
  },
): Promise<ShiftHandoverRecord> {
  const result = await getPool().query<ShiftHandoverRow>(
    `INSERT INTO shift_handovers
       (id, client_id, building_id, outgoing_shift_id, incoming_shift_id,
        handover_date, prepared_by_user_id, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, client_id, building_id, outgoing_shift_id,
               incoming_shift_id, handover_date, prepared_by_user_id,
               acknowledged_by_user_id, summary, status, prepared_at,
               acknowledged_at, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.outgoingShiftId,
      input.incomingShiftId,
      input.handoverDate,
      input.preparedByUserId,
      input.summary,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<ShiftHandoverRecord | null> {
  const result = await getPool().query<ShiftHandoverRow>(
    `SELECT id, client_id, building_id, outgoing_shift_id, incoming_shift_id,
            handover_date, prepared_by_user_id, acknowledged_by_user_id,
            summary, status, prepared_at, acknowledged_at, created_at,
            updated_at
     FROM shift_handovers WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuilding(
  buildingId: string,
  date?: string,
): Promise<ShiftHandoverRecord[]> {
  const result = await getPool().query<ShiftHandoverRow>(
    `SELECT id, client_id, building_id, outgoing_shift_id, incoming_shift_id,
            handover_date, prepared_by_user_id, acknowledged_by_user_id,
            summary, status, prepared_at, acknowledged_at, created_at,
            updated_at
     FROM shift_handovers
     WHERE building_id = $1
       AND ($2::date IS NULL OR handover_date = $2)
     ORDER BY handover_date DESC, created_at DESC`,
    [buildingId, date ?? null],
  );
  return result.rows.map(mapRow);
}

export async function updateSummary(
  id: string,
  summary: string,
): Promise<ShiftHandoverRecord | null> {
  const result = await getPool().query<ShiftHandoverRow>(
    `UPDATE shift_handovers
     SET summary = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING id, client_id, building_id, outgoing_shift_id,
               incoming_shift_id, handover_date, prepared_by_user_id,
               acknowledged_by_user_id, summary, status, prepared_at,
               acknowledged_at, created_at, updated_at`,
    [id, summary],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function markReady(
  id: string,
): Promise<ShiftHandoverRecord | null> {
  const result = await getPool().query<ShiftHandoverRow>(
    `UPDATE shift_handovers
     SET status = 'READY', updated_at = NOW()
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING id, client_id, building_id, outgoing_shift_id,
               incoming_shift_id, handover_date, prepared_by_user_id,
               acknowledged_by_user_id, summary, status, prepared_at,
               acknowledged_at, created_at, updated_at`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function acknowledge(
  id: string,
  acknowledgedByUserId: string,
): Promise<ShiftHandoverRecord | null> {
  const result = await getPool().query<ShiftHandoverRow>(
    `UPDATE shift_handovers
     SET status = 'ACKNOWLEDGED',
         acknowledged_by_user_id = $2,
         acknowledged_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = 'READY'
     RETURNING id, client_id, building_id, outgoing_shift_id,
               incoming_shift_id, handover_date, prepared_by_user_id,
               acknowledged_by_user_id, summary, status, prepared_at,
               acknowledged_at, created_at, updated_at`,
    [id, acknowledgedByUserId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findShift(shiftId: string): Promise<ShiftRow | null> {
  const result = await getPool().query<ShiftRow>(
    `SELECT id, building_id, code, name, start_time, end_time, status
     FROM shifts WHERE id = $1`,
    [shiftId],
  );
  return result.rows[0] ?? null;
}

/** Active Work Orders for the Building. */
export async function listActiveWorkOrders(
  buildingId: string,
): Promise<HandoverItem[]> {
  const result = await getPool().query<HandoverItem>(
    `SELECT w.id, w.work_order_number AS "referenceNumber", w.title, w.status,
            a.asset_code AS "assetCode"
     FROM work_orders w
     LEFT JOIN assets a ON a.id = w.asset_id
     WHERE w.building_id = $1
       AND w.status = ANY($2::text[])
     ORDER BY w.created_at DESC`,
    [buildingId, OPEN_WORK_ORDER_STATUSES],
  );
  return result.rows.map((row) => ({ ...row, kind: 'WORK_ORDER' }));
}

/** Open breakdowns with their corrective Work Order state. */
export async function listOpenBreakdowns(
  buildingId: string,
): Promise<HandoverItem[]> {
  const result = await getPool().query<HandoverItem>(
    `SELECT bb.id, bb.category AS "referenceNumber", bb.description AS title,
            bb.status, a.asset_code AS "assetCode"
     FROM breakdown_bindings bb
     JOIN assets a ON a.id = bb.asset_id
     WHERE bb.building_id = $1 AND bb.status = 'OPEN'
     ORDER BY bb.reported_at DESC`,
    [buildingId],
  );
  return result.rows.map((row) => ({ ...row, kind: 'BREAKDOWN' }));
}

/** Open Engineering Findings. */
export async function listOpenFindings(
  buildingId: string,
): Promise<HandoverItem[]> {
  const result = await getPool().query<HandoverItem>(
    `SELECT f.id, f.finding_number AS "referenceNumber", f.title, f.status,
            a.asset_code AS "assetCode"
     FROM findings f
     LEFT JOIN engineering_finding_links l ON l.finding_id = f.id
     LEFT JOIN assets a ON a.id = l.asset_id
     WHERE f.building_id = $1
       AND f.status = ANY($2::text[])
     ORDER BY f.reported_at DESC`,
    [buildingId, OPEN_FINDING_STATUSES],
  );
  return result.rows.map((row) => ({ ...row, kind: 'FINDING' }));
}

/** Incomplete inspection executions (DRAFT / IN_PROGRESS). */
export async function listIncompleteInspections(
  buildingId: string,
): Promise<HandoverItem[]> {
  const result = await getPool().query<HandoverItem>(
    `SELECT ce.id, ct.code AS "referenceNumber", ct.name AS title, ce.status,
            a.asset_code AS "assetCode"
     FROM checklist_executions ce
     JOIN inspection_bindings ib ON ib.id = ce.inspection_binding_id
     JOIN checklist_templates ct ON ct.id = ce.checklist_template_id
     JOIN assets a ON a.id = ib.asset_id
     WHERE ib.building_id = $1
       AND ce.status = ANY($2::text[])
     ORDER BY ce.created_at DESC`,
    [buildingId, INCOMPLETE_EXECUTION_STATUSES],
  );
  return result.rows.map((row) => ({ ...row, kind: 'INSPECTION' }));
}

/** Incomplete engineering checklist executions. */
export async function listIncompleteChecklists(
  buildingId: string,
): Promise<HandoverItem[]> {
  const result = await getPool().query<HandoverItem>(
    `SELECT ce.id, ct.code AS "referenceNumber", ct.name AS title, ce.status,
            a.asset_code AS "assetCode"
     FROM checklist_executions ce
     JOIN engineering_checklist_bindings ecb
       ON ecb.id = ce.engineering_checklist_binding_id
     JOIN checklist_templates ct ON ct.id = ce.checklist_template_id
     LEFT JOIN assets a ON a.id = ecb.asset_id
     WHERE ecb.building_id = $1
       AND ce.status = ANY($2::text[])
     ORDER BY ce.created_at DESC`,
    [buildingId, INCOMPLETE_EXECUTION_STATUSES],
  );
  return result.rows.map((row) => ({ ...row, kind: 'CHECKLIST' }));
}

/** Incomplete meter reading executions. */
export async function listIncompleteMeterReadings(
  buildingId: string,
): Promise<HandoverItem[]> {
  const result = await getPool().query<HandoverItem>(
    `SELECT fi.id, u.code AS "referenceNumber", u.name AS title, fi.status,
            a.asset_code AS "assetCode"
     FROM form_instances fi
     JOIN meter_reading_bindings mrb ON mrb.id = fi.meter_reading_binding_id
     JOIN assets a ON a.id = mrb.asset_id
     JOIN units_of_measure u ON u.id = mrb.uom_id
     WHERE mrb.building_id = $1
       AND fi.status = ANY($2::text[])
     ORDER BY fi.created_at DESC`,
    [buildingId, INCOMPLETE_EXECUTION_STATUSES],
  );
  return result.rows.map((row) => ({ ...row, kind: 'METER_READING' }));
}

/** Incomplete log sheet executions. */
export async function listIncompleteLogSheets(
  buildingId: string,
): Promise<HandoverItem[]> {
  const result = await getPool().query<HandoverItem>(
    `SELECT fi.id, ft.code AS "referenceNumber", ft.name AS title, fi.status,
            a.asset_code AS "assetCode"
     FROM form_instances fi
     JOIN log_sheet_bindings lsb ON lsb.id = fi.log_sheet_binding_id
     JOIN form_templates ft ON ft.id = lsb.form_template_id
     JOIN assets a ON a.id = lsb.asset_id
     WHERE lsb.building_id = $1
       AND fi.status = ANY($2::text[])
     ORDER BY fi.created_at DESC`,
    [buildingId, INCOMPLETE_EXECUTION_STATUSES],
  );
  return result.rows.map((row) => ({ ...row, kind: 'EQUIPMENT_LOG' }));
}

/** Pending maintenance: active bindings whose Work Order is still open. */
export async function listPendingMaintenance(
  buildingId: string,
): Promise<HandoverItem[]> {
  const result = await getPool().query<HandoverItem>(
    `SELECT mb.id, w.work_order_number AS "referenceNumber", mb.name AS title,
            w.status, a.asset_code AS "assetCode"
     FROM maintenance_bindings mb
     JOIN assets a ON a.id = mb.asset_id
     JOIN work_orders w ON w.id = mb.work_order_id
     WHERE mb.building_id = $1
       AND mb.status = 'ACTIVE'
       AND w.status = ANY($2::text[])
     ORDER BY mb.created_at DESC`,
    [buildingId, OPEN_WORK_ORDER_STATUSES],
  );
  return result.rows.map((row) => ({ ...row, kind: 'MAINTENANCE' }));
}

/** Scheduled / open generated tasks for the Building. */
export async function listScheduledTasks(
  buildingId: string,
): Promise<HandoverItem[]> {
  const result = await getPool().query<HandoverItem>(
    `SELECT t.id, s.code AS "referenceNumber", s.name AS title, t.status,
            a.asset_code AS "assetCode"
     FROM generated_tasks t
     JOIN schedule_definitions s ON s.id = t.schedule_definition_id
     LEFT JOIN maintenance_bindings mb ON mb.id = t.maintenance_binding_id
     LEFT JOIN assets a ON a.id = mb.asset_id
     WHERE t.building_id = $1
       AND t.status = ANY($2::text[])
     ORDER BY t.occurrence_at DESC
     LIMIT 100`,
    [buildingId, SCHEDULED_TASK_STATUSES],
  );
  return result.rows.map((row) => ({ ...row, kind: 'TASK' }));
}

export const shiftHandoverRepository = {
  acknowledge,
  create,
  findById,
  findShift,
  listActiveWorkOrders,
  listByBuilding,
  listIncompleteChecklists,
  listIncompleteInspections,
  listIncompleteLogSheets,
  listIncompleteMeterReadings,
  listOpenBreakdowns,
  listOpenFindings,
  listPendingMaintenance,
  listScheduledTasks,
  markReady,
  updateSummary,
};
