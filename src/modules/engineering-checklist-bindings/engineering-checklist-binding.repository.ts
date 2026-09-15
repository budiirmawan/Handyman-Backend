import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  EngineeringChecklistBindingRecord,
  EngineeringChecklistBindingStatus,
} from './engineering-checklist-binding.types';

/**
 * BE-10E — Engineering Checklist Binding repository.
 *
 * Holds binding references and starts executions on the shared BE-07
 * `checklist_executions` table (the only table BE-07 execution rows live
 * in). Responses stay in BE-07's own `checklist_item_responses` store.
 */

type EngineeringChecklistBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  checklist_template_id: string;
  asset_id: string | null;
  functional_location_id: string | null;
  status: EngineeringChecklistBindingStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

export type ChecklistTemplateRow = {
  id: string;
  client_id: string;
  code: string;
  name: string;
  status: string;
};

/** A measurement checklist item (NUMBER-type) carrying a UOM. */
export type MeasurementItemRow = {
  id: string;
  item_type: string;
  uom_id: string | null;
};

export type ExecutionRow = {
  id: string;
  client_id: string;
  checklist_template_id: string;
  engineering_checklist_binding_id: string | null;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type ExecutionContextRow = {
  execution_id: string;
  execution_template_id: string;
  execution_status: string;
  execution_started_at: Date | null;
  execution_completed_at: Date | null;
  execution_created_at: Date;
  execution_updated_at: Date;
  engineering_checklist_binding_id: string | null;
  building_id: string | null;
  building_code: string | null;
  building_name: string | null;
  template_id: string | null;
  template_code: string | null;
  template_name: string | null;
  template_status: string | null;
  asset_id: string | null;
  asset_code: string | null;
  asset_name: string | null;
  asset_status: string | null;
  functional_location_id: string | null;
  functional_location_code: string | null;
  functional_location_name: string | null;
  functional_location_status: string | null;
};

function mapRow(row: EngineeringChecklistBindingRow): EngineeringChecklistBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    checklistTemplateId: row.checklist_template_id,
    assetId: row.asset_id,
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
    checklistTemplateId: string;
    assetId: string | null;
    functionalLocationId: string | null;
    status: EngineeringChecklistBindingStatus;
    createdByUserId: string;
  },
): Promise<EngineeringChecklistBindingRecord> {
  const result = await getPool().query<EngineeringChecklistBindingRow>(
    `INSERT INTO engineering_checklist_bindings
       (id, client_id, building_id, checklist_template_id, asset_id,
        functional_location_id, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, client_id, building_id, checklist_template_id, asset_id,
               functional_location_id, status, created_by_user_id,
               created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.checklistTemplateId,
      input.assetId,
      input.functionalLocationId,
      input.status,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<EngineeringChecklistBindingRecord | null> {
  const result = await getPool().query<EngineeringChecklistBindingRow>(
    `SELECT id, client_id, building_id, checklist_template_id, asset_id,
            functional_location_id, status, created_by_user_id,
            created_at, updated_at
     FROM engineering_checklist_bindings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuildingId(
  buildingId: string,
): Promise<EngineeringChecklistBindingRecord[]> {
  const result = await getPool().query<EngineeringChecklistBindingRow>(
    `SELECT id, client_id, building_id, checklist_template_id, asset_id,
            functional_location_id, status, created_by_user_id,
            created_at, updated_at
     FROM engineering_checklist_bindings
     WHERE building_id = $1
     ORDER BY created_at DESC`,
    [buildingId],
  );
  return result.rows.map(mapRow);
}

/** Bindings across the caller's accessible Buildings (BE-02G scope). */
export async function listByBuildingIds(
  buildingIds: string[],
): Promise<EngineeringChecklistBindingRecord[]> {
  const result = await getPool().query<EngineeringChecklistBindingRow>(
    `SELECT id, client_id, building_id, checklist_template_id, asset_id,
            functional_location_id, status, created_by_user_id,
            created_at, updated_at
     FROM engineering_checklist_bindings
     WHERE building_id = ANY($1::uuid[])
     ORDER BY created_at DESC`,
    [buildingIds],
  );
  return result.rows.map(mapRow);
}

export async function listByAssetId(
  assetId: string,
): Promise<EngineeringChecklistBindingRecord[]> {
  const result = await getPool().query<EngineeringChecklistBindingRow>(
    `SELECT id, client_id, building_id, checklist_template_id, asset_id,
            functional_location_id, status, created_by_user_id,
            created_at, updated_at
     FROM engineering_checklist_bindings
     WHERE asset_id = $1
     ORDER BY created_at DESC`,
    [assetId],
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: {
    assetId?: string | null;
    functionalLocationId?: string | null;
    status?: EngineeringChecklistBindingStatus;
  },
): Promise<EngineeringChecklistBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.assetId !== undefined) {
    values.push(input.assetId);
    sets.push(`asset_id = $${values.length}`);
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
  const result = await getPool().query<EngineeringChecklistBindingRow>(
    `UPDATE engineering_checklist_bindings
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING id, client_id, building_id, checklist_template_id, asset_id,
               functional_location_id, status, created_by_user_id,
               created_at, updated_at`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findChecklistTemplate(
  templateId: string,
): Promise<ChecklistTemplateRow | null> {
  const result = await getPool().query<ChecklistTemplateRow>(
    `SELECT id, client_id, code, name, status
     FROM checklist_templates WHERE id = $1`,
    [templateId],
  );
  return result.rows[0] ?? null;
}

/**
 * Measurement items configured on the template: NUMBER-type checklist items
 * whose measurement config carries a UOM (BE-07 measurement configuration).
 */
export async function listTemplateMeasurementItems(
  templateId: string,
): Promise<MeasurementItemRow[]> {
  const result = await getPool().query<MeasurementItemRow>(
    `SELECT id, item_type, uom_id
     FROM checklist_items
     WHERE checklist_template_id = $1
       AND item_type = 'NUMBER'
       AND status = 'ACTIVE'`,
    [templateId],
  );
  return result.rows;
}

export async function findUom(
  uomId: string,
): Promise<{ id: string; client_id: string; status: string } | null> {
  const result = await getPool().query<{ id: string; client_id: string; status: string }>(
    `SELECT id, client_id, status FROM units_of_measure WHERE id = $1`,
    [uomId],
  );
  return result.rows[0] ?? null;
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
       (id, client_id, checklist_template_id, engineering_checklist_binding_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, client_id, checklist_template_id,
               engineering_checklist_binding_id, status, started_at,
               completed_at, created_at, updated_at`,
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
 * Resolves the engineering checklist context of a checklist execution:
 * execution → its binding → Building / Template / Asset / Functional
 * Location. A single authoritative join — the context is never stored
 * separately.
 */
export async function findExecutionContext(
  executionId: string,
): Promise<ExecutionContextRow | null> {
  const result = await getPool().query<ExecutionContextRow>(
    `SELECT
       ce.id AS execution_id,
       ce.checklist_template_id AS execution_template_id,
       ce.status AS execution_status,
       ce.started_at AS execution_started_at,
       ce.completed_at AS execution_completed_at,
       ce.created_at AS execution_created_at,
       ce.updated_at AS execution_updated_at,
       ecb.id AS engineering_checklist_binding_id,
       b.id AS building_id,
       b.code AS building_code,
       b.name AS building_name,
       ct.id AS template_id,
       ct.code AS template_code,
       ct.name AS template_name,
       ct.status AS template_status,
       a.id AS asset_id,
       a.asset_code AS asset_code,
       a.asset_name AS asset_name,
       a.status AS asset_status,
       fl.id AS functional_location_id,
       fl.code AS functional_location_code,
       fl.name AS functional_location_name,
       fl.status AS functional_location_status
     FROM checklist_executions ce
     LEFT JOIN engineering_checklist_bindings ecb
       ON ecb.id = ce.engineering_checklist_binding_id
     LEFT JOIN buildings b ON b.id = ecb.building_id
     LEFT JOIN checklist_templates ct ON ct.id = ecb.checklist_template_id
     LEFT JOIN assets a ON a.id = ecb.asset_id
     LEFT JOIN functional_locations fl ON fl.id = ecb.functional_location_id
     WHERE ce.id = $1`,
    [executionId],
  );
  return result.rows[0] ?? null;
}

export const engineeringChecklistBindingRepository = {
  create,
  findById,
  findChecklistTemplate,
  findExecutionContext,
  findUom,
  insertExecution,
  listByAssetId,
  listByBuildingId,
  listByBuildingIds,
  listTemplateMeasurementItems,
  update,
};
