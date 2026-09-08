import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewWorkOrderProcurementBinding,
  WorkOrderProcurementBindingRecord,
  WOProcurementStatus,
} from './work-order-procurement-binding.types';

type Row = {
  id: string;
  clientId: string;
  buildingId: string;
  workOrderId: string;
  purchaseRequestId: string;
  materialRequestId: string | null;
  serviceRequestId: string | null;
  receivingId: string | null;
  workContractId: string | null;
  purchaseOrderId: string | null;
  vendorId: string | null;
  procurementStatus: string;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `id, client_id AS "clientId", building_id AS "buildingId",
  work_order_id AS "workOrderId", purchase_request_id AS "purchaseRequestId",
  material_request_id AS "materialRequestId",
  service_request_id AS "serviceRequestId", receiving_id AS "receivingId",
  work_contract_id AS "workContractId",
  purchase_order_id AS "purchaseOrderId", vendor_id AS "vendorId",
  procurement_status AS "procurementStatus", notes,
  created_by_user_id AS "createdByUserId", created_at AS "createdAt",
  updated_at AS "updatedAt"`;

function mapRow(row: Row): WorkOrderProcurementBindingRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    workOrderId: row.workOrderId,
    purchaseRequestId: row.purchaseRequestId,
    materialRequestId: row.materialRequestId,
    serviceRequestId: row.serviceRequestId,
    receivingId: row.receivingId,
    workContractId: row.workContractId,
    purchaseOrderId: row.purchaseOrderId,
    vendorId: row.vendorId,
    procurementStatus: row.procurementStatus as WOProcurementStatus,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(
  input: NewWorkOrderProcurementBinding,
): Promise<WorkOrderProcurementBindingRecord> {
  const result = await getPool().query<Row>(
    `INSERT INTO work_order_procurement_bindings
       (id, client_id, building_id, work_order_id, purchase_request_id,
        material_request_id, service_request_id, receiving_id,
        work_contract_id, purchase_order_id, vendor_id,
        procurement_status, notes, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.workOrderId,
      input.purchaseRequestId,
      input.materialRequestId,
      input.serviceRequestId,
      input.receivingId,
      input.workContractId,
      input.purchaseOrderId,
      input.vendorId,
      input.procurementStatus,
      input.notes,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<WorkOrderProcurementBindingRecord | null> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM work_order_procurement_bindings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function findByWorkOrderId(
  workOrderId: string,
): Promise<WorkOrderProcurementBindingRecord | null> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM work_order_procurement_bindings
     WHERE work_order_id = $1`,
    [workOrderId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function findByIdWithDetails(
  id: string,
): Promise<Record<string, unknown> | null> {
  const result = await getPool().query(
    `SELECT
       b.id, b.client_id AS "clientId", b.building_id AS "buildingId",
       b.work_order_id AS "workOrderId",
       b.purchase_request_id AS "purchaseRequestId",
       b.material_request_id AS "materialRequestId",
       b.service_request_id AS "serviceRequestId",
       b.receiving_id AS "receivingId",
       b.work_contract_id AS "workContractId",
       b.purchase_order_id AS "purchaseOrderId",
       b.vendor_id AS "vendorId",
       b.procurement_status AS "procurementStatus", b.notes,
       b.created_by_user_id AS "createdByUserId",
       b.created_at AS "createdAt", b.updated_at AS "updatedAt",
       wo.work_order_number AS "woNumber", wo.title AS "woTitle", wo.status AS "woStatus",
       pr.request_number AS "prNumber", pr.title AS "prTitle", pr.status AS "prStatus",
       mr.item_id AS "mrItemId", mr.quantity AS "mrQuantity", mr.status AS "mrStatus",
       sr.service_type AS "srServiceType", sr.title AS "srTitle", sr.status AS "srStatus",
       rv.receiving_type AS "rvType", rv.status AS "rvStatus",
       wc.spk_number AS "wcNumber", wc.title AS "wcTitle", wc.status AS "wcStatus",
       po.po_number AS "poNumber", po.status AS "poStatus"
     FROM work_order_procurement_bindings b
     LEFT JOIN work_orders wo ON wo.id = b.work_order_id
     LEFT JOIN purchase_requests pr ON pr.id = b.purchase_request_id
     LEFT JOIN material_requests mr ON mr.id = b.material_request_id
     LEFT JOIN service_requests sr ON sr.id = b.service_request_id
     LEFT JOIN receivings rv ON rv.id = b.receiving_id
     LEFT JOIN work_contracts wc ON wc.id = b.work_contract_id
     LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
     WHERE b.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function listByWorkOrderId(
  workOrderId: string,
): Promise<WorkOrderProcurementBindingRecord[]> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM work_order_procurement_bindings
     WHERE work_order_id = $1 ORDER BY created_at ASC`,
    [workOrderId],
  );
  return result.rows.map(mapRow);
}

async function updateStatus(
  id: string,
  status: WOProcurementStatus,
): Promise<WorkOrderProcurementBindingRecord | null> {
  const result = await getPool().query<Row>(
    `UPDATE work_order_procurement_bindings
     SET procurement_status = $2, updated_at = NOW()
     WHERE id = $1 RETURNING ${SELECT}`,
    [id, status],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function linkReceiving(
  id: string,
  receivingId: string,
): Promise<WorkOrderProcurementBindingRecord | null> {
  const result = await getPool().query<Row>(
    `UPDATE work_order_procurement_bindings
     SET receiving_id = $2, procurement_status = 'RECEIVED', updated_at = NOW()
     WHERE id = $1 RETURNING ${SELECT}`,
    [id, receivingId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * CR-BE-R2P-01 PART 05 — binds an ACTIVE SPK onto the EXISTING authoritative
 * binding row. This is an extension of that row, never a second binding
 * domain.
 *
 * The `work_contract_id IS NULL` guard lives in the WHERE clause, so binding
 * is atomic: two concurrent commands cannot both succeed, and an
 * already-bound row simply matches nothing (returns null). The composite FK
 * `wo_procurement_spk_scope_fk` simultaneously re-verifies, in the database,
 * that the binding's client/building and the supplied vendor/PO all agree
 * with the SPK.
 */
async function bindWorkContract(
  id: string,
  chain: { workContractId: string; purchaseOrderId: string; vendorId: string },
): Promise<WorkOrderProcurementBindingRecord | null> {
  const result = await getPool().query<Row>(
    `UPDATE work_order_procurement_bindings
     SET work_contract_id = $2, purchase_order_id = $3, vendor_id = $4,
         updated_at = NOW()
     WHERE id = $1 AND work_contract_id IS NULL
     RETURNING ${SELECT}`,
    [id, chain.workContractId, chain.purchaseOrderId, chain.vendorId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const workOrderProcurementBindingRepository = {
  bindWorkContract,
  create,
  findById,
  findByWorkOrderId,
  findByIdWithDetails,
  linkReceiving,
  listByWorkOrderId,
  updateStatus,
};
