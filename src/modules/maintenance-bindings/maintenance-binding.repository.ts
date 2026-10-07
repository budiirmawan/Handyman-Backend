import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  MaintenanceBindingRecord,
  MaintenanceBindingStatus,
  MaintenanceType,
} from './maintenance-binding.types';

/**
 * BE-10G — Maintenance Operational Binding repository.
 *
 * Holds maintenance binding references, creates shared BE-07 schedule
 * definitions, and links BE-07 generated tasks and BE-08 Work Orders by
 * reference. Schedules, tasks, and Work Orders remain owned by BE-07 /
 * BE-08 — this repository never duplicates their data.
 */

type MaintenanceBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  asset_id: string;
  functional_location_id: string | null;
  schedule_definition_id: string | null;
  work_order_id: string | null;
  name: string;
  maintenance_type: MaintenanceType;
  description: string | null;
  status: MaintenanceBindingStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

export type ScheduleRow = {
  id: string;
  client_id: string;
  building_id: string | null;
  code: string;
  name: string;
  target_type: string;
  target_id: string;
  timezone: string;
  status: string;
};

export type TaskRow = {
  id: string;
  client_id: string;
  schedule_definition_id: string;
  building_id: string | null;
  status: string;
  occurrence_at: Date;
  maintenance_binding_id: string | null;
};

export type WorkOrderRow = {
  id: string;
  work_order_number: string;
  title: string;
  status: string;
  building_id: string;
};

function mapRow(row: MaintenanceBindingRow): MaintenanceBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    assetId: row.asset_id,
    functionalLocationId: row.functional_location_id,
    scheduleDefinitionId: row.schedule_definition_id,
    workOrderId: row.work_order_id,
    name: row.name,
    maintenanceType: row.maintenance_type,
    description: row.description,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: {
    clientId: string;
    buildingId: string;
    assetId: string;
    functionalLocationId: string | null;
    name: string;
    maintenanceType: MaintenanceType;
    description: string | null;
    status: MaintenanceBindingStatus;
    createdByUserId: string;
  },
): Promise<MaintenanceBindingRecord> {
  const result = await getPool().query<MaintenanceBindingRow>(
    `INSERT INTO maintenance_bindings
       (id, client_id, building_id, asset_id, functional_location_id,
        name, maintenance_type, description, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, client_id, building_id, asset_id, functional_location_id,
               schedule_definition_id, work_order_id, name, maintenance_type,
               description, status, created_by_user_id, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.assetId,
      input.functionalLocationId,
      input.name,
      input.maintenanceType,
      input.description,
      input.status,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<MaintenanceBindingRecord | null> {
  const result = await getPool().query<MaintenanceBindingRow>(
    `SELECT id, client_id, building_id, asset_id, functional_location_id,
            schedule_definition_id, work_order_id, name, maintenance_type,
            description, status, created_by_user_id, created_at, updated_at
     FROM maintenance_bindings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByAssetId(
  assetId: string,
): Promise<MaintenanceBindingRecord[]> {
  const result = await getPool().query<MaintenanceBindingRow>(
    `SELECT id, client_id, building_id, asset_id, functional_location_id,
            schedule_definition_id, work_order_id, name, maintenance_type,
            description, status, created_by_user_id, created_at, updated_at
     FROM maintenance_bindings
     WHERE asset_id = $1
     ORDER BY created_at DESC`,
    [assetId],
  );
  return result.rows.map(mapRow);
}

export async function listByBuildingId(
  buildingId: string,
): Promise<MaintenanceBindingRecord[]> {
  const result = await getPool().query<MaintenanceBindingRow>(
    `SELECT id, client_id, building_id, asset_id, functional_location_id,
            schedule_definition_id, work_order_id, name, maintenance_type,
            description, status, created_by_user_id, created_at, updated_at
     FROM maintenance_bindings
     WHERE building_id = $1
     ORDER BY created_at DESC`,
    [buildingId],
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: {
    name?: string;
    maintenanceType?: MaintenanceType;
    description?: string | null;
    functionalLocationId?: string | null;
    status?: MaintenanceBindingStatus;
  },
): Promise<MaintenanceBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.maintenanceType !== undefined) {
    values.push(input.maintenanceType);
    sets.push(`maintenance_type = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.functionalLocationId !== undefined) {
    values.push(input.functionalLocationId);
    sets.push(`functional_location_id = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  values.push(id);
  const result = await getPool().query<MaintenanceBindingRow>(
    `UPDATE maintenance_bindings
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING id, client_id, building_id, asset_id, functional_location_id,
               schedule_definition_id, work_order_id, name, maintenance_type,
               description, status, created_by_user_id, created_at, updated_at`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function linkSchedule(
  id: string,
  scheduleDefinitionId: string,
): Promise<MaintenanceBindingRecord | null> {
  const result = await getPool().query<MaintenanceBindingRow>(
    `UPDATE maintenance_bindings
     SET schedule_definition_id = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, client_id, building_id, asset_id, functional_location_id,
               schedule_definition_id, work_order_id, name, maintenance_type,
               description, status, created_by_user_id, created_at, updated_at`,
    [id, scheduleDefinitionId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function linkWorkOrder(
  id: string,
  workOrderId: string,
): Promise<MaintenanceBindingRecord | null> {
  const result = await getPool().query<MaintenanceBindingRow>(
    `UPDATE maintenance_bindings
     SET work_order_id = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, client_id, building_id, asset_id, functional_location_id,
               schedule_definition_id, work_order_id, name, maintenance_type,
               description, status, created_by_user_id, created_at, updated_at`,
    [id, workOrderId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Creates the shared BE-07 schedule definition row for a maintenance
 * binding. BE-07 remains the authority for its lifecycle and task
 * generation; this is the same insert BE-07's schedule endpoint performs.
 */
export async function insertSchedule(
  input: {
    clientId: string;
    buildingId: string;
    code: string;
    name: string;
    targetType: string;
    targetId: string;
    startAt: string;
    timezone: string;
  },
): Promise<ScheduleRow> {
  const result = await getPool().query<ScheduleRow>(
    `INSERT INTO schedule_definitions
       (id, client_id, code, name, target_type, target_id, building_id,
        start_at, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, client_id, building_id, code, name, target_type,
               target_id, timezone, status`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.name,
      input.targetType,
      input.targetId,
      input.buildingId,
      input.startAt,
      input.timezone,
    ],
  );
  return result.rows[0];
}

export async function findSchedule(
  scheduleId: string,
): Promise<ScheduleRow | null> {
  const result = await getPool().query<ScheduleRow>(
    `SELECT id, client_id, building_id, code, name, target_type, target_id,
            timezone, status
     FROM schedule_definitions WHERE id = $1`,
    [scheduleId],
  );
  return result.rows[0] ?? null;
}

export async function findWorkOrder(
  workOrderId: string,
): Promise<WorkOrderRow | null> {
  const result = await getPool().query<WorkOrderRow>(
    `SELECT id, work_order_number, title, status, building_id
     FROM work_orders WHERE id = $1`,
    [workOrderId],
  );
  return result.rows[0] ?? null;
}

export async function findTask(taskId: string): Promise<TaskRow | null> {
  const result = await getPool().query<TaskRow>(
    `SELECT id, client_id, schedule_definition_id, building_id, status,
            occurrence_at, maintenance_binding_id
     FROM generated_tasks WHERE id = $1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

export async function linkTask(
  taskId: string,
  bindingId: string,
): Promise<TaskRow | null> {
  const result = await getPool().query<TaskRow>(
    `UPDATE generated_tasks
     SET maintenance_binding_id = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, client_id, schedule_definition_id, building_id, status,
               occurrence_at, maintenance_binding_id`,
    [taskId, bindingId],
  );
  return result.rows[0] ?? null;
}

/** Tasks linked to the binding directly or through its shared schedule. */
export async function listBindingTasks(
  bindingId: string,
  scheduleDefinitionId: string | null,
): Promise<TaskRow[]> {
  const result = await getPool().query<TaskRow>(
    `SELECT id, client_id, schedule_definition_id, building_id, status,
            occurrence_at, maintenance_binding_id
     FROM generated_tasks
     WHERE maintenance_binding_id = $1
        OR ($2::uuid IS NOT NULL AND schedule_definition_id = $2)
     ORDER BY occurrence_at DESC
     LIMIT 100`,
    [bindingId, scheduleDefinitionId],
  );
  return result.rows;
}

export const maintenanceBindingRepository = {
  create,
  findById,
  findSchedule,
  findTask,
  findWorkOrder,
  insertSchedule,
  linkSchedule,
  linkTask,
  linkWorkOrder,
  listBindingTasks,
  listByAssetId,
  listByBuildingId,
  update,
};
