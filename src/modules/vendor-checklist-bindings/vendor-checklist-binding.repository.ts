import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewVendorChecklistBinding,
  VendorChecklistBindingRecord,
  VendorChecklistBindingStatus,
} from './vendor-checklist-binding.types';

/**
 * BE-15C — Vendor Checklist Binding repository.
 *
 * Holds binding references and starts executions on the shared BE-07
 * `checklist_executions` table (the only table BE-07 execution rows live in).
 * Responses stay in BE-07's own `checklist_item_responses` store.
 */

type VendorChecklistBindingRow = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  checklistTemplateId: string;
  checklistExecutionId: string | null;
  buildingId: string;
  workOrderId: string;
  status: VendorChecklistBindingStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ChecklistTemplateRow = {
  id: string;
  client_id: string;
  code: string;
  name: string;
  status: string;
};

export type ExecutionRow = {
  id: string;
  client_id: string;
  checklist_template_id: string;
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
  vendor_checklist_binding_id: string | null;
  vendor_work_id: string | null;
  vendor_work_status: string | null;
  vendor_id: string | null;
  building_id: string | null;
  building_code: string | null;
  building_name: string | null;
  work_order_id: string | null;
  work_order_number: string | null;
  work_order_status: string | null;
  template_id: string | null;
  template_code: string | null;
  template_name: string | null;
  template_status: string | null;
};

const BINDING_SELECT = `
  id,
  client_id AS "clientId",
  vendor_work_id AS "vendorWorkId",
  checklist_template_id AS "checklistTemplateId",
  checklist_execution_id AS "checklistExecutionId",
  building_id AS "buildingId",
  work_order_id AS "workOrderId",
  status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: VendorChecklistBindingRow): VendorChecklistBindingRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    vendorWorkId: row.vendorWorkId,
    checklistTemplateId: row.checklistTemplateId,
    checklistExecutionId: row.checklistExecutionId,
    buildingId: row.buildingId,
    workOrderId: row.workOrderId,
    status: row.status,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(
  input: NewVendorChecklistBinding,
): Promise<VendorChecklistBindingRecord> {
  const result = await getPool().query<VendorChecklistBindingRow>(
    `INSERT INTO vendor_checklist_bindings
       (id, client_id, vendor_work_id, checklist_template_id, building_id,
        work_order_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${BINDING_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.vendorWorkId,
      input.checklistTemplateId,
      input.buildingId,
      input.workOrderId,
      input.createdByUserId,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<VendorChecklistBindingRecord | null> {
  const result = await getPool().query<VendorChecklistBindingRow>(
    `SELECT ${BINDING_SELECT} FROM vendor_checklist_bindings WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findActiveByVendorWorkAndTemplate(
  vendorWorkId: string,
  checklistTemplateId: string,
): Promise<VendorChecklistBindingRecord | null> {
  const result = await getPool().query<VendorChecklistBindingRow>(
    `SELECT ${BINDING_SELECT} FROM vendor_checklist_bindings
     WHERE vendor_work_id = $1 AND checklist_template_id = $2 AND status = 'ACTIVE'
     LIMIT 1`,
    [vendorWorkId, checklistTemplateId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Lists bindings scoped to the caller's accessible Building set, optionally
 * narrowed by Vendor Work / Vendor (via `vendor_works`) / Building.
 */
async function list(input: {
  vendorWorkId?: string;
  vendorId?: string;
  buildingId?: string;
  buildingIds: string[];
}): Promise<VendorChecklistBindingRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  values.push(input.buildingIds);
  conditions.push(`vcb.building_id = ANY($${values.length})`);

  if (input.vendorWorkId) {
    values.push(input.vendorWorkId);
    conditions.push(`vcb.vendor_work_id = $${values.length}`);
  }
  if (input.vendorId) {
    values.push(input.vendorId);
    conditions.push(`vw.vendor_id = $${values.length}`);
  }
  if (input.buildingId) {
    values.push(input.buildingId);
    conditions.push(`vcb.building_id = $${values.length}`);
  }

  const result = await getPool().query<VendorChecklistBindingRow>(
    `SELECT
       vcb.id,
       vcb.client_id AS "clientId",
       vcb.vendor_work_id AS "vendorWorkId",
       vcb.checklist_template_id AS "checklistTemplateId",
       vcb.checklist_execution_id AS "checklistExecutionId",
       vcb.building_id AS "buildingId",
       vcb.work_order_id AS "workOrderId",
       vcb.status,
       vcb.created_by_user_id AS "createdByUserId",
       vcb.created_at AS "createdAt",
       vcb.updated_at AS "updatedAt"
     FROM vendor_checklist_bindings vcb
     LEFT JOIN vendor_works vw ON vw.id = vcb.vendor_work_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY vcb.created_at ASC`,
    values,
  );

  return result.rows.map(mapRow);
}

async function findChecklistTemplate(
  templateId: string,
): Promise<ChecklistTemplateRow | null> {
  const result = await getPool().query<ChecklistTemplateRow>(
    `SELECT id, client_id, code, name, status
     FROM checklist_templates WHERE id = $1`,
    [templateId],
  );
  return result.rows[0] ?? null;
}

/** Starts the shared BE-07 checklist execution for a binding. */
async function insertExecution(input: {
  clientId: string;
  checklistTemplateId: string;
}): Promise<ExecutionRow> {
  const result = await getPool().query<ExecutionRow>(
    `INSERT INTO checklist_executions (id, client_id, checklist_template_id)
     VALUES ($1, $2, $3)
     RETURNING id, client_id, checklist_template_id, status, started_at,
               completed_at, created_at, updated_at`,
    [randomUUID(), input.clientId, input.checklistTemplateId],
  );
  return result.rows[0];
}

/** Links a started BE-07 execution back to the binding. */
async function linkExecution(
  bindingId: string,
  executionId: string,
): Promise<VendorChecklistBindingRecord | null> {
  const result = await getPool().query<VendorChecklistBindingRow>(
    `UPDATE vendor_checklist_bindings
     SET checklist_execution_id = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${BINDING_SELECT}`,
    [bindingId, executionId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findExecution(executionId: string): Promise<ExecutionRow | null> {
  const result = await getPool().query<ExecutionRow>(
    `SELECT id, client_id, checklist_template_id, status, started_at,
            completed_at, created_at, updated_at
     FROM checklist_executions WHERE id = $1`,
    [executionId],
  );
  return result.rows[0] ?? null;
}

/**
 * Resolves the vendor checklist context of a checklist execution:
 * execution → binding → Vendor Work / Building / Work Order / Template. A
 * single authoritative join — the context is never stored separately.
 */
async function findExecutionContext(
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
       vcb.id AS vendor_checklist_binding_id,
       vw.id AS vendor_work_id,
       vw.status AS vendor_work_status,
       vw.vendor_id AS vendor_id,
       b.id AS building_id,
       b.code AS building_code,
       b.name AS building_name,
       wo.id AS work_order_id,
       wo.work_order_number AS work_order_number,
       wo.status AS work_order_status,
       ct.id AS template_id,
       ct.code AS template_code,
       ct.name AS template_name,
       ct.status AS template_status
     FROM checklist_executions ce
     JOIN vendor_checklist_bindings vcb ON vcb.checklist_execution_id = ce.id
     JOIN vendor_works vw ON vw.id = vcb.vendor_work_id
     JOIN buildings b ON b.id = vcb.building_id
     JOIN work_orders wo ON wo.id = vcb.work_order_id
     JOIN checklist_templates ct ON ct.id = vcb.checklist_template_id
     WHERE ce.id = $1`,
    [executionId],
  );
  return result.rows[0] ?? null;
}

export const vendorChecklistBindingRepository = {
  create,
  findActiveByVendorWorkAndTemplate,
  findById,
  findChecklistTemplate,
  findExecutionContext,
  findExecution,
  insertExecution,
  linkExecution,
  list,
};
