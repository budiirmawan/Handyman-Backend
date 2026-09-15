import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  BastRequirement,
  NewWorkOrder,
  UpdateWorkOrderInput,
  WorkOrderFilters,
  WorkOrderPriority,
  WorkOrderRecord,
  WorkOrderStatus,
} from './work-order.types';

type WorkOrderRow = {
  id: string;
  clientId: string;
  buildingId: string;
  workOrderNumber: string;
  workRequestId: string | null;
  title: string;
  description: string | null;
  workType: string;
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  bastRequirement: BastRequirement;
  createdByUserId: string;
  assetId: string | null;
  functionalLocationId: string | null;
  assignedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  completedByUserId: string | null;
  completionSummary: string | null;
  completionNotes: string | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const WORK_ORDER_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  work_order_number AS "workOrderNumber",
  work_request_id AS "workRequestId",
  title,
  description,
  work_type AS "workType",
  priority,
  status,
  bast_requirement AS "bastRequirement",
  created_by_user_id AS "createdByUserId",
  asset_id AS "assetId",
  functional_location_id AS "functionalLocationId",
  assigned_at AS "assignedAt",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  completed_by_user_id AS "completedByUserId",
  completion_summary AS "completionSummary",
  completion_notes AS "completionNotes",
  closed_at AS "closedAt",
  cancelled_at AS "cancelledAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: WorkOrderRow): WorkOrderRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    workOrderNumber: row.workOrderNumber,
    workRequestId: row.workRequestId,
    title: row.title,
    description: row.description,
    workType: row.workType,
    priority: row.priority,
    status: row.status,
    bastRequirement: row.bastRequirement,
    createdByUserId: row.createdByUserId,
    assetId: row.assetId,
    functionalLocationId: row.functionalLocationId,
    assignedAt: row.assignedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    completedByUserId: row.completedByUserId,
    completionSummary: row.completionSummary,
    completionNotes: row.completionNotes,
    closedAt: row.closedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(
  input: NewWorkOrder,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<WorkOrderRecord> {
  const result = await executor.query<WorkOrderRow>(
    `INSERT INTO work_orders
       (id, client_id, building_id, work_order_number, work_request_id, title,
        description, work_type, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN', $9)
     RETURNING ${WORK_ORDER_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.workOrderNumber,
      input.workRequestId,
      input.title,
      input.description,
      input.workType,
      input.createdByUserId,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<WorkOrderRecord | null> {
  const result = await getPool().query<WorkOrderRow>(
    `SELECT ${WORK_ORDER_SELECT} FROM work_orders WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByWorkOrderNumberForClient(
  clientId: string,
  workOrderNumber: string,
): Promise<WorkOrderRecord | null> {
  const result = await getPool().query<WorkOrderRow>(
    `SELECT ${WORK_ORDER_SELECT} FROM work_orders
     WHERE client_id = $1 AND work_order_number = $2`,
    [clientId, workOrderNumber],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByWorkRequestId(
  workRequestId: string,
): Promise<WorkOrderRecord | null> {
  const result = await getPool().query<WorkOrderRow>(
    `SELECT ${WORK_ORDER_SELECT} FROM work_orders
     WHERE work_request_id = $1`,
    [workRequestId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByBuilding(
  buildingId: string,
  filters: WorkOrderFilters,
): Promise<WorkOrderRecord[]> {
  const conditions: string[] = ['building_id = $1'];
  const values: unknown[] = [buildingId];

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.workType !== undefined) {
    values.push(filters.workType);
    conditions.push(`work_type = $${values.length}`);
  }
  if (filters.workRequestId !== undefined) {
    values.push(filters.workRequestId);
    conditions.push(`work_request_id = $${values.length}`);
  }

  const result = await getPool().query<WorkOrderRow>(
    `SELECT ${WORK_ORDER_SELECT} FROM work_orders
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );

  return result.rows.map(mapRow);
}

/**
 * CR-BE-MOB-03 PART 04 — team-scoped Work Order list (TMW-04).
 *
 * Lists Work Orders whose ACTIVE BE-08E assignment is to the given Team
 * (`assignee_type = 'TEAM'` with `team_id = $2`) or to any of the given
 * Workforce Profile ids (`assignee_type = 'WORKFORCE'` with
 * `workforce_profile_id = ANY($3::uuid[])` — the ACTIVE members of the
 * caller's team). `buildingIds` is the caller's BE-02G accessible Building
 * set and is enforced in SQL, so no cross-Building / cross-Client Work Order
 * can ever be returned. Only ACTIVE assignments are considered (the BE-08E
 * one-ACTIVE-assignment invariant), so deactivated history never widens the
 * result. The same optional status / workType / workRequestId filters as
 * `listByBuilding` are supported; Work Order ids, lifecycle and shapes are
 * the authoritative BE-08 ones (no projection, no duplicate domain).
 */
async function listByTeamAssignments(
  teamId: string,
  memberProfileIds: string[],
  buildingIds: string[],
  filters: WorkOrderFilters,
): Promise<WorkOrderRecord[]> {
  const conditions: string[] = [
    'w.building_id = ANY($1::uuid[])',
    `EXISTS (
       SELECT 1 FROM work_order_assignments a
       WHERE a.work_order_id = w.id
         AND a.status = 'ACTIVE'
         AND (
           (a.assignee_type = 'TEAM' AND a.team_id = $2)
           OR (a.assignee_type = 'WORKFORCE'
               AND a.workforce_profile_id = ANY($3::uuid[]))
         )
     )`,
  ];
  const values: unknown[] = [buildingIds, teamId, memberProfileIds];

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`w.status = $${values.length}`);
  }
  if (filters.workType !== undefined) {
    values.push(filters.workType);
    conditions.push(`w.work_type = $${values.length}`);
  }
  if (filters.workRequestId !== undefined) {
    values.push(filters.workRequestId);
    conditions.push(`w.work_request_id = $${values.length}`);
  }

  const result = await getPool().query<WorkOrderRow>(
    `SELECT ${WORK_ORDER_SELECT} FROM work_orders w
     WHERE ${conditions.join(' AND ')}
     ORDER BY w.created_at DESC`,
    values,
  );

  return result.rows.map(mapRow);
}

async function update(
  id: string,
  input: UpdateWorkOrderInput,
): Promise<WorkOrderRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.title !== undefined) {
    values.push(input.title);
    sets.push(`title = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.workType !== undefined) {
    values.push(input.workType);
    sets.push(`work_type = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push('updated_at = NOW()');

  const result = await getPool().query<WorkOrderRow>(
    `UPDATE work_orders SET ${sets.join(', ')}
     WHERE id = $${values.length}
     RETURNING ${WORK_ORDER_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updatePriority(
  id: string,
  priority: WorkOrderPriority,
): Promise<WorkOrderRecord | null> {
  const result = await getPool().query<WorkOrderRow>(
    `UPDATE work_orders SET priority = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${WORK_ORDER_SELECT}`,
    [id, priority],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function hasBastSubmissionAttempts(id: string): Promise<boolean> {
  const result = await getPool().query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM bast_submission_attempts bsa
       JOIN bast_documents bd ON bd.id = bsa.bast_document_id
       WHERE bd.work_order_id = $1
     ) AS present`,
    [id],
  );
  return result.rows[0]?.present ?? false;
}

async function updateBastRequirement(
  id: string,
  bastRequirement: BastRequirement,
): Promise<WorkOrderRecord | null> {
  const result = await getPool().query<WorkOrderRow>(
    `UPDATE work_orders
     SET bast_requirement = $2, updated_at = NOW()
     WHERE id = $1
       AND status NOT IN ('COMPLETED', 'CLOSED', 'CANCELLED')
       AND NOT EXISTS (
         SELECT 1
         FROM bast_submission_attempts bsa
         JOIN bast_documents bd ON bd.id = bsa.bast_document_id
         WHERE bd.work_order_id = $1
       )
     RETURNING ${WORK_ORDER_SELECT}`,
    [id, bastRequirement],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Applies a lifecycle transition. Timestamps are set per the target status:
 * `assigned_at`/`started_at` are captured only on first entry (COALESCE), so
 * ON_HOLD → IN_PROGRESS preserves the original start; `completed_at`,
 * `closed_at`, and `cancelled_at` are stamped on their target status.
 */
async function updateStatus(
  id: string,
  status: WorkOrderStatus,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<WorkOrderRecord | null> {
  const result = await executor.query<WorkOrderRow>(
    `UPDATE work_orders SET
       status = $2,
       assigned_at = CASE WHEN $2 = 'ASSIGNED' AND assigned_at IS NULL THEN NOW() ELSE assigned_at END,
       started_at = CASE WHEN $2 = 'IN_PROGRESS' AND started_at IS NULL THEN NOW() ELSE started_at END,
       completed_at = CASE WHEN $2 = 'COMPLETED' THEN NOW() ELSE completed_at END,
       closed_at = CASE WHEN $2 = 'CLOSED' THEN NOW() ELSE closed_at END,
       cancelled_at = CASE WHEN $2 = 'CANCELLED' THEN NOW() ELSE cancelled_at END,
       updated_at = NOW()
     WHERE id = $1
     RETURNING ${WORK_ORDER_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Applies the Asset / Functional Location binding fields. Omitted fields are
 * left unchanged; an explicit null clears a binding.
 */
/**
 * Marks a Work Order COMPLETED with the completion actor and notes. Only the
 * service may call this after validating readiness; the raw status transition
 * is NOT exposed here.
 */
async function complete(
  id: string,
  input: {
    completedByUserId: string;
    completionSummary: string | null;
    completionNotes: string | null;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<WorkOrderRecord | null> {
  const result = await executor.query<WorkOrderRow>(
    `UPDATE work_orders SET
       status = 'COMPLETED',
       completed_at = NOW(),
       completed_by_user_id = $2,
       completion_summary = $3,
       completion_notes = $4,
       updated_at = NOW()
     WHERE id = $1 AND status <> 'COMPLETED'
     RETURNING ${WORK_ORDER_SELECT}`,
    [
      id,
      input.completedByUserId,
      input.completionSummary,
      input.completionNotes,
    ],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updateContext(
  id: string,
  assetId: string | null | undefined,
  functionalLocationId: string | null | undefined,
): Promise<WorkOrderRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (assetId !== undefined) {
    values.push(assetId);
    sets.push(`asset_id = $${values.length}`);
  }
  if (functionalLocationId !== undefined) {
    values.push(functionalLocationId);
    sets.push(`functional_location_id = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push('updated_at = NOW()');

  const result = await getPool().query<WorkOrderRow>(
    `UPDATE work_orders SET ${sets.join(', ')}
     WHERE id = $${values.length}
     RETURNING ${WORK_ORDER_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const workOrderRepository = {
  complete,
  create,
  findById,
  findByWorkOrderNumberForClient,
  findByWorkRequestId,
  hasBastSubmissionAttempts,
  listByBuilding,
  listByTeamAssignments,
  update,
  updateBastRequirement,
  updateContext,
  updatePriority,
  updateStatus,
};
