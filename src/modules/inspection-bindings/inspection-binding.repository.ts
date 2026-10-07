import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  InspectionBindingRecord,
  InspectionBindingStatus,
} from './inspection-binding.types';

/**
 * BE-10B — Equipment Inspection Binding repository.
 *
 * Holds binding references and starts executions on the shared BE-07
 * `checklist_executions` table (the only table BE-07 execution rows live in).
 */

type InspectionBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  asset_id: string;
  checklist_template_id: string;
  functional_location_id: string | null;
  status: InspectionBindingStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

type ExecutionRow = {
  id: string;
  client_id: string;
  checklist_template_id: string;
  inspection_binding_id: string | null;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type ExecutionContextRow = {
  execution_id: string;
  execution_checklist_template_id: string;
  execution_status: string;
  execution_started_at: Date | null;
  execution_completed_at: Date | null;
  execution_created_at: Date;
  execution_updated_at: Date;
  inspection_binding_id: string | null;
  asset_id: string | null;
  asset_code: string | null;
  asset_name: string | null;
  asset_status: string | null;
  building_id: string | null;
  building_code: string | null;
  building_name: string | null;
  functional_location_id: string | null;
  functional_location_code: string | null;
  functional_location_name: string | null;
  functional_location_status: string | null;
};

function mapRow(row: InspectionBindingRow): InspectionBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    assetId: row.asset_id,
    checklistTemplateId: row.checklist_template_id,
    functionalLocationId: row.functional_location_id,
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
    checklistTemplateId: string;
    functionalLocationId: string | null;
    status: InspectionBindingStatus;
    createdByUserId: string;
  },
): Promise<InspectionBindingRecord> {
  const result = await getPool().query<InspectionBindingRow>(
    `INSERT INTO inspection_bindings
       (id, client_id, building_id, asset_id, checklist_template_id,
        functional_location_id, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, client_id, building_id, asset_id, checklist_template_id,
               functional_location_id, status, created_by_user_id,
               created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.assetId,
      input.checklistTemplateId,
      input.functionalLocationId,
      input.status,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<InspectionBindingRecord | null> {
  const result = await getPool().query<InspectionBindingRow>(
    `SELECT id, client_id, building_id, asset_id, checklist_template_id,
            functional_location_id, status, created_by_user_id,
            created_at, updated_at
     FROM inspection_bindings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findActiveByAssetAndTemplate(
  assetId: string,
  checklistTemplateId: string,
): Promise<InspectionBindingRecord | null> {
  const result = await getPool().query<InspectionBindingRow>(
    `SELECT id, client_id, building_id, asset_id, checklist_template_id,
            functional_location_id, status, created_by_user_id,
            created_at, updated_at
     FROM inspection_bindings
     WHERE asset_id = $1 AND checklist_template_id = $2 AND status = 'ACTIVE'`,
    [assetId, checklistTemplateId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByAssetId(
  assetId: string,
): Promise<InspectionBindingRecord[]> {
  const result = await getPool().query<InspectionBindingRow>(
    `SELECT id, client_id, building_id, asset_id, checklist_template_id,
            functional_location_id, status, created_by_user_id,
            created_at, updated_at
     FROM inspection_bindings
     WHERE asset_id = $1
     ORDER BY created_at DESC`,
    [assetId],
  );
  return result.rows.map(mapRow);
}

export async function listByBuildingId(
  buildingId: string,
): Promise<InspectionBindingRecord[]> {
  const result = await getPool().query<InspectionBindingRow>(
    `SELECT id, client_id, building_id, asset_id, checklist_template_id,
            functional_location_id, status, created_by_user_id,
            created_at, updated_at
     FROM inspection_bindings
     WHERE building_id = $1
     ORDER BY created_at DESC`,
    [buildingId],
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: { functionalLocationId?: string | null; status?: InspectionBindingStatus },
): Promise<InspectionBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.functionalLocationId !== undefined) {
    values.push(input.functionalLocationId);
    sets.push(`functional_location_id = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  values.push(id);
  const result = await getPool().query<InspectionBindingRow>(
    `UPDATE inspection_bindings
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING id, client_id, building_id, asset_id, checklist_template_id,
               functional_location_id, status, created_by_user_id,
               created_at, updated_at`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Starts the shared BE-07 checklist execution for a binding. */
export async function insertExecution(
  input: {
    bindingId: string;
    clientId: string;
    checklistTemplateId: string;
  },
): Promise<ExecutionRow> {
  const result = await getPool().query<ExecutionRow>(
    `INSERT INTO checklist_executions
       (id, client_id, checklist_template_id, inspection_binding_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, client_id, checklist_template_id, inspection_binding_id,
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

/**
 * Resolves the inspection context of a checklist execution: execution → its
 * binding → Asset / Building / Functional Location. A single authoritative
 * join — the context is never stored separately.
 */
export async function findExecutionContext(
  executionId: string,
): Promise<ExecutionContextRow | null> {
  const result = await getPool().query<ExecutionContextRow>(
    `SELECT
       ce.id AS execution_id,
       ce.checklist_template_id AS execution_checklist_template_id,
       ce.status AS execution_status,
       ce.started_at AS execution_started_at,
       ce.completed_at AS execution_completed_at,
       ce.created_at AS execution_created_at,
       ce.updated_at AS execution_updated_at,
       ib.id AS inspection_binding_id,
       a.id AS asset_id,
       a.asset_code AS asset_code,
       a.asset_name AS asset_name,
       a.status AS asset_status,
       b.id AS building_id,
       b.code AS building_code,
       b.name AS building_name,
       fl.id AS functional_location_id,
       fl.code AS functional_location_code,
       fl.name AS functional_location_name,
       fl.status AS functional_location_status
     FROM checklist_executions ce
     LEFT JOIN inspection_bindings ib ON ib.id = ce.inspection_binding_id
     LEFT JOIN assets a ON a.id = ib.asset_id
     LEFT JOIN buildings b ON b.id = ib.building_id
     LEFT JOIN functional_locations fl ON fl.id = ib.functional_location_id
     WHERE ce.id = $1`,
    [executionId],
  );
  return result.rows[0] ?? null;
}

export const inspectionBindingRepository = {
  create,
  findActiveByAssetAndTemplate,
  findById,
  findExecutionContext,
  insertExecution,
  listByAssetId,
  listByBuildingId,
  update,
};
