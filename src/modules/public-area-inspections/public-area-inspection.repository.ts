import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  PublicAreaInspectionBindingFilter,
  PublicAreaInspectionBindingRecord,
  PublicAreaInspectionStatus,
  UpdatePublicAreaInspectionBindingInput,
} from './public-area-inspection.types';

type PublicAreaInspectionBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  cleaning_area_id: string;
  checklist_template_id: string;
  floor_id: string | null;
  area_id: string | null;
  room_id: string | null;
  functional_location_id: string | null;
  description: string | null;
  status: PublicAreaInspectionStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

type ChecklistExecutionRow = {
  id: string;
  client_id: string;
  checklist_template_id: string;
  public_area_inspection_binding_id: string | null;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type PublicAreaExecutionContextRow = {
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
  floor_id: string | null;
  floor_code: string | null;
  floor_name: string | null;
  area_id: string | null;
  area_code: string | null;
  area_name: string | null;
  room_id: string | null;
  room_code: string | null;
  room_name: string | null;
  functional_location_id: string | null;
  functional_location_code: string | null;
  functional_location_name: string | null;
  functional_location_status: string | null;
  binding_description: string | null;
  binding_status: PublicAreaInspectionStatus;
  binding_created_by_user_id: string;
  binding_created_at: Date;
  binding_updated_at: Date;
};

function mapRow(
  row: PublicAreaInspectionBindingRow,
): PublicAreaInspectionBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    cleaningAreaId: row.cleaning_area_id,
    checklistTemplateId: row.checklist_template_id,
    floorId: row.floor_id,
    areaId: row.area_id,
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
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  functionalLocationId: string | null;
  description: string | null;
  status: PublicAreaInspectionStatus;
  createdByUserId: string;
}): Promise<PublicAreaInspectionBindingRecord> {
  const result = await getPool().query<PublicAreaInspectionBindingRow>(
    `INSERT INTO public_area_inspection_bindings
       (id, client_id, building_id, cleaning_area_id, checklist_template_id,
        floor_id, area_id, room_id, functional_location_id,
        description, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, client_id, building_id, cleaning_area_id,
               checklist_template_id, floor_id, area_id, room_id,
               functional_location_id, description, status,
               created_by_user_id, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.cleaningAreaId,
      input.checklistTemplateId,
      input.floorId,
      input.areaId,
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
): Promise<PublicAreaInspectionBindingRecord | null> {
  const result = await getPool().query<PublicAreaInspectionBindingRow>(
    `SELECT id, client_id, building_id, cleaning_area_id,
            checklist_template_id, floor_id, area_id, room_id,
            functional_location_id, description, status,
            created_by_user_id, created_at, updated_at
     FROM public_area_inspection_bindings
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findActiveByAreaAndTemplate(
  cleaningAreaId: string,
  checklistTemplateId: string,
): Promise<PublicAreaInspectionBindingRecord | null> {
  const result = await getPool().query<PublicAreaInspectionBindingRow>(
    `SELECT id, client_id, building_id, cleaning_area_id,
            checklist_template_id, floor_id, area_id, room_id,
            functional_location_id, description, status,
            created_by_user_id, created_at, updated_at
     FROM public_area_inspection_bindings
     WHERE cleaning_area_id = $1 AND checklist_template_id = $2
       AND status = 'ACTIVE'`,
    [cleaningAreaId, checklistTemplateId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function list(
  filter: PublicAreaInspectionBindingFilter = {},
): Promise<PublicAreaInspectionBindingRecord[]> {
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

  const result = await getPool().query<PublicAreaInspectionBindingRow>(
    `SELECT id, client_id, building_id, cleaning_area_id,
            checklist_template_id, floor_id, area_id, room_id,
            functional_location_id, description, status,
            created_by_user_id, created_at, updated_at
     FROM public_area_inspection_bindings
     ${whereClause}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdatePublicAreaInspectionBindingInput,
): Promise<PublicAreaInspectionBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.floorId !== undefined) {
    values.push(input.floorId);
    sets.push(`floor_id = $${values.length}`);
  }

  if (input.areaId !== undefined) {
    values.push(input.areaId);
    sets.push(`area_id = $${values.length}`);
  }

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
  const result = await getPool().query<PublicAreaInspectionBindingRow>(
    `UPDATE public_area_inspection_bindings
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING id, client_id, building_id, cleaning_area_id,
               checklist_template_id, floor_id, area_id, room_id,
               functional_location_id, description, status,
               created_by_user_id, created_at, updated_at`,
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
       (id, client_id, checklist_template_id, public_area_inspection_binding_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, client_id, checklist_template_id,
               public_area_inspection_binding_id,
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
): Promise<PublicAreaExecutionContextRow | null> {
  const result = await getPool().query<PublicAreaExecutionContextRow>(
    `SELECT
       ce.id AS execution_id,
       ce.checklist_template_id AS execution_checklist_template_id,
       ce.status AS execution_status,
       ce.started_at AS execution_started_at,
       ce.completed_at AS execution_completed_at,
       ce.created_at AS execution_created_at,
       ce.updated_at AS execution_updated_at,
       pab.id AS binding_id,
       pab.client_id AS client_id,
       pab.building_id AS building_id,
       pab.cleaning_area_id AS cleaning_area_id,
       ca.code AS cleaning_area_code,
       ca.name AS cleaning_area_name,
       ca.cleaning_area_type AS cleaning_area_type,
       ca.status AS cleaning_area_status,
       pab.checklist_template_id AS checklist_template_id,
       ct.code AS template_code,
       ct.name AS template_name,
       ct.status AS template_status,
       pab.floor_id AS floor_id,
       flr.code AS floor_code,
       flr.name AS floor_name,
       pab.area_id AS area_id,
       ar.code AS area_code,
       ar.name AS area_name,
       pab.room_id AS room_id,
       rm.code AS room_code,
       rm.name AS room_name,
       pab.functional_location_id AS functional_location_id,
       fl.code AS functional_location_code,
       fl.name AS functional_location_name,
       fl.status AS functional_location_status,
       pab.description AS binding_description,
       pab.status AS binding_status,
       pab.created_by_user_id AS binding_created_by_user_id,
       pab.created_at AS binding_created_at,
       pab.updated_at AS binding_updated_at
     FROM checklist_executions ce
     JOIN public_area_inspection_bindings pab
       ON pab.id = ce.public_area_inspection_binding_id
     JOIN cleaning_areas ca
       ON ca.id = pab.cleaning_area_id
     JOIN checklist_templates ct
       ON ct.id = pab.checklist_template_id
     LEFT JOIN floors flr
       ON flr.id = pab.floor_id
     LEFT JOIN areas ar
       ON ar.id = pab.area_id
     LEFT JOIN rooms rm
       ON rm.id = pab.room_id
     LEFT JOIN functional_locations fl
       ON fl.id = pab.functional_location_id
     WHERE ce.id = $1`,
    [executionId],
  );
  return result.rows[0] ?? null;
}

export const publicAreaInspectionRepository = {
  create,
  findActiveByAreaAndTemplate,
  findById,
  findExecutionContext,
  insertExecution,
  list,
  update,
};
