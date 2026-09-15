import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  ToiletInspectionBindingFilter,
  ToiletInspectionBindingRecord,
  ToiletInspectionStatus,
  UpdateToiletInspectionBindingInput,
} from './toilet-inspection.types';

type ToiletInspectionBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  cleaning_area_id: string;
  checklist_template_id: string;
  room_id: string | null;
  functional_location_id: string | null;
  description: string | null;
  status: ToiletInspectionStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

type ChecklistExecutionRow = {
  id: string;
  client_id: string;
  checklist_template_id: string;
  toilet_inspection_binding_id: string | null;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type ToiletExecutionContextRow = {
  execution_id: string;
  execution_checklist_template_id: string;
  execution_status: string;
  execution_started_at: Date | null;
  execution_completed_at: Date | null;
  execution_created_at: Date;
  execution_updated_at: Date;
  binding_id: string;
  client_id: string;
  building_id: string;
  cleaning_area_id: string;
  cleaning_area_code: string;
  cleaning_area_name: string;
  cleaning_area_type: string;
  cleaning_area_status: string;
  checklist_template_id: string;
  template_code: string;
  template_name: string;
  template_status: string;
  room_id: string | null;
  room_code: string | null;
  room_name: string | null;
  functional_location_id: string | null;
  functional_location_code: string | null;
  functional_location_name: string | null;
  functional_location_status: string | null;
  binding_description: string | null;
  binding_status: ToiletInspectionStatus;
  binding_created_by_user_id: string;
  binding_created_at: Date;
  binding_updated_at: Date;
};

function mapRow(row: ToiletInspectionBindingRow): ToiletInspectionBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    cleaningAreaId: row.cleaning_area_id,
    checklistTemplateId: row.checklist_template_id,
    roomId: row.room_id,
    functionalLocationId: row.functional_location_id,
    description: row.description,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(input: {
  clientId: string;
  buildingId: string;
  cleaningAreaId: string;
  checklistTemplateId: string;
  roomId: string | null;
  functionalLocationId: string | null;
  description: string | null;
  status: ToiletInspectionStatus;
  createdByUserId: string;
}): Promise<ToiletInspectionBindingRecord> {
  const result = await getPool().query<ToiletInspectionBindingRow>(
    `INSERT INTO toilet_inspection_bindings
       (id, client_id, building_id, cleaning_area_id, checklist_template_id,
        room_id, functional_location_id, description, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, client_id, building_id, cleaning_area_id,
               checklist_template_id, room_id, functional_location_id,
               description, status, created_by_user_id,
               created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.cleaningAreaId,
      input.checklistTemplateId,
      input.roomId,
      input.functionalLocationId,
      input.description ?? null,
      input.status,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<ToiletInspectionBindingRecord | null> {
  const result = await getPool().query<ToiletInspectionBindingRow>(
    `SELECT id, client_id, building_id, cleaning_area_id,
            checklist_template_id, room_id, functional_location_id,
            description, status, created_by_user_id,
            created_at, updated_at
     FROM toilet_inspection_bindings
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findActiveByAreaAndTemplate(
  cleaningAreaId: string,
  checklistTemplateId: string,
): Promise<ToiletInspectionBindingRecord | null> {
  const result = await getPool().query<ToiletInspectionBindingRow>(
    `SELECT id, client_id, building_id, cleaning_area_id,
            checklist_template_id, room_id, functional_location_id,
            description, status, created_by_user_id,
            created_at, updated_at
     FROM toilet_inspection_bindings
     WHERE cleaning_area_id = $1 AND checklist_template_id = $2
       AND status = 'ACTIVE'`,
    [cleaningAreaId, checklistTemplateId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function list(
  filter: ToiletInspectionBindingFilter = {},
): Promise<ToiletInspectionBindingRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.buildingId) {
    values.push(filter.buildingId);
    conditions.push(`building_id = $${values.length}`);
  }

  if (filter.cleaningAreaId) {
    values.push(filter.cleaningAreaId);
    conditions.push(`cleaning_area_id = $${values.length}`);
  }

  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await getPool().query<ToiletInspectionBindingRow>(
    `SELECT id, client_id, building_id, cleaning_area_id,
            checklist_template_id, room_id, functional_location_id,
            description, status, created_by_user_id,
            created_at, updated_at
     FROM toilet_inspection_bindings
     ${whereClause}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdateToiletInspectionBindingInput,
): Promise<ToiletInspectionBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.roomId !== undefined) {
    values.push(input.roomId);
    sets.push(`room_id = $${values.length}`);
  }

  if (input.functionalLocationId !== undefined) {
    values.push(input.functionalLocationId);
    sets.push(`functional_location_id = $${values.length}`);
  }

  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }

  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<ToiletInspectionBindingRow>(
    `UPDATE toilet_inspection_bindings
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING id, client_id, building_id, cleaning_area_id,
               checklist_template_id, room_id, functional_location_id,
               description, status, created_by_user_id,
               created_at, updated_at`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function insertExecution(input: {
  bindingId: string;
  clientId: string;
  checklistTemplateId: string;
}): Promise<ChecklistExecutionRow> {
  const result = await getPool().query<ChecklistExecutionRow>(
    `INSERT INTO checklist_executions
       (id, client_id, checklist_template_id, toilet_inspection_binding_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, client_id, checklist_template_id, toilet_inspection_binding_id,
               status, started_at, completed_at, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.checklistTemplateId,
      input.bindingId,
    ],
  );
  return result.rows[0];
}

export async function findExecutionContext(
  executionId: string,
): Promise<ToiletExecutionContextRow | null> {
  const result = await getPool().query<ToiletExecutionContextRow>(
    `SELECT
       ce.id AS execution_id,
       ce.checklist_template_id AS execution_checklist_template_id,
       ce.status AS execution_status,
       ce.started_at AS execution_started_at,
       ce.completed_at AS execution_completed_at,
       ce.created_at AS execution_created_at,
       ce.updated_at AS execution_updated_at,
       tib.id AS binding_id,
       tib.client_id AS client_id,
       tib.building_id AS building_id,
       tib.cleaning_area_id AS cleaning_area_id,
       ca.code AS cleaning_area_code,
       ca.name AS cleaning_area_name,
       ca.cleaning_area_type AS cleaning_area_type,
       ca.status AS cleaning_area_status,
       tib.checklist_template_id AS checklist_template_id,
       ct.code AS template_code,
       ct.name AS template_name,
       ct.status AS template_status,
       tib.room_id AS room_id,
       rm.code AS room_code,
       rm.name AS room_name,
       tib.functional_location_id AS functional_location_id,
       fl.code AS functional_location_code,
       fl.name AS functional_location_name,
       fl.status AS functional_location_status,
       tib.description AS binding_description,
       tib.status AS binding_status,
       tib.created_by_user_id AS binding_created_by_user_id,
       tib.created_at AS binding_created_at,
       tib.updated_at AS binding_updated_at
     FROM checklist_executions ce
     JOIN toilet_inspection_bindings tib
       ON tib.id = ce.toilet_inspection_binding_id
     JOIN cleaning_areas ca
       ON ca.id = tib.cleaning_area_id
     JOIN checklist_templates ct
       ON ct.id = tib.checklist_template_id
     LEFT JOIN rooms rm
       ON rm.id = tib.room_id
     LEFT JOIN functional_locations fl
       ON fl.id = tib.functional_location_id
     WHERE ce.id = $1`,
    [executionId],
  );
  return result.rows[0] ?? null;
}

export const toiletInspectionRepository = {
  create,
  findActiveByAreaAndTemplate,
  findById,
  findExecutionContext,
  insertExecution,
  list,
  update,
};
