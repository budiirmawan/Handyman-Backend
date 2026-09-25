import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type { MaterialRequestStatus } from '../material-requests/material-request.types';
import type { MaterialReservationStatus } from '../inventory-material-reservations/inventory-material-reservation.types';

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 01 — field read queries.
 *
 * Cardinality authority is `purchase_requests.work_order_id` (PART 00), never
 * `work_order_procurement_bindings.material_request_id`. Every row returned
 * here is a material_request whose parent Purchase Request is a Work-Order
 * field parent; management material requests (parent with NULL work_order_id)
 * are invisible to this surface.
 */
export type MobileMaterialRequestRow = {
  id: string;
  workOrderId: string;
  purchaseRequestId: string;
  purchaseRequestNumber: string;
  clientId: string;
  buildingId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  itemType: string;
  quantity: string;
  approvedQuantity: string | null;
  uomId: string | null;
  uomCode: string | null;
  uomName: string | null;
  uomSymbol: string | null;
  requiredDate: Date | null;
  notes: string | null;
  status: MaterialRequestStatus;
  requestedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `
  mr.id,
  pr.work_order_id            AS "workOrderId",
  mr.purchase_request_id      AS "purchaseRequestId",
  pr.request_number           AS "purchaseRequestNumber",
  mr.client_id                AS "clientId",
  mr.building_id              AS "buildingId",
  mr.item_id                  AS "itemId",
  i.code                      AS "itemCode",
  i.name                      AS "itemName",
  i.item_type                 AS "itemType",
  mr.quantity::text           AS "quantity",
  mr.approved_quantity::text  AS "approvedQuantity",
  mr.uom_id                   AS "uomId",
  u.code                      AS "uomCode",
  u.name                      AS "uomName",
  u.symbol                    AS "uomSymbol",
  mr.required_date            AS "requiredDate",
  mr.notes,
  mr.status,
  mr.requested_by_user_id     AS "requestedByUserId",
  mr.created_at               AS "createdAt",
  mr.updated_at               AS "updatedAt"
`;

const FROM = `
  FROM material_requests mr
  JOIN purchase_requests pr ON pr.id = mr.purchase_request_id
  JOIN inventory_items i ON i.id = mr.item_id
  LEFT JOIN units_of_measure u ON u.id = mr.uom_id
`;

async function listByWorkOrder(workOrderId: string): Promise<MobileMaterialRequestRow[]> {
  const result = await getPool().query<MobileMaterialRequestRow>(
    `SELECT ${SELECT} ${FROM}
     WHERE pr.work_order_id = $1
     ORDER BY mr.created_at ASC, mr.id ASC`,
    [workOrderId],
  );
  return result.rows;
}

/** Only resolves a material request attached to a Work-Order field parent. */
async function findFieldById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<MobileMaterialRequestRow | null> {
  const result = await executor.query<MobileMaterialRequestRow>(
    `SELECT ${SELECT} ${FROM}
     WHERE mr.id = $1 AND pr.work_order_id IS NOT NULL`,
    [id],
  );
  return result.rows[0] ?? null;
}

/* ------------------------------------------------------------------------ */
/* CR-BE-RN11-MATERIAL-FIELD-01 PART 02 — read-only awareness seams          */
/* ------------------------------------------------------------------------ */

/** Canonical inventory_material_reservations row (+ warehouse metadata). */
export type MobileMaterialReservationRow = {
  id: string;
  materialRequestId: string;
  warehouseId: string;
  warehouseCode: string | null;
  warehouseName: string | null;
  reservedQuantity: string;
  consumedQuantity: string;
  remainingQuantity: string;
  status: MaterialReservationStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Canonical inventory_work_order_material_usages row (+ warehouse metadata). */
export type MobileMaterialIssueRow = {
  id: string;
  materialRequestId: string;
  reservationId: string | null;
  warehouseId: string;
  warehouseCode: string | null;
  warehouseName: string | null;
  itemId: string;
  quantity: string;
  uomId: string | null;
  usedAt: Date;
  usedByUserId: string;
  reference: string | null;
  notes: string | null;
  stockMovementId: string | null;
  createdAt: Date;
};

/** Field item discovery row — identity + UOM only, never stock. */
export type MobileMaterialItemRow = {
  itemId: string;
  code: string;
  name: string;
  itemType: string;
  uomId: string | null;
  uomCode: string | null;
  uomName: string | null;
  uomSymbol: string | null;
};

/** Detail: every reservation of the request — canonical order (newest first). */
async function listReservationsByMaterialRequest(
  materialRequestId: string,
): Promise<MobileMaterialReservationRow[]> {
  const result = await getPool().query<MobileMaterialReservationRow>(
    `SELECT
       r.id,
       r.material_request_id      AS "materialRequestId",
       r.warehouse_id             AS "warehouseId",
       w.code                     AS "warehouseCode",
       w.name                     AS "warehouseName",
       r.reserved_quantity::text  AS "reservedQuantity",
       r.consumed_quantity::text  AS "consumedQuantity",
       r.remaining_quantity::text AS "remainingQuantity",
       r.status,
       r.created_at               AS "createdAt",
       r.updated_at               AS "updatedAt"
     FROM inventory_material_reservations r
     LEFT JOIN inventory_warehouses w ON w.id = r.warehouse_id
     WHERE r.material_request_id = $1
     ORDER BY r.created_at DESC, r.id DESC`,
    [materialRequestId],
  );
  return result.rows;
}

const ISSUE_SELECT = `
  u.id,
  u.material_request_id AS "materialRequestId",
  u.reservation_id      AS "reservationId",
  u.warehouse_id        AS "warehouseId",
  w.code                AS "warehouseCode",
  w.name                AS "warehouseName",
  u.item_id             AS "itemId",
  u.quantity::text      AS "quantity",
  u.uom_id              AS "uomId",
  u.used_at             AS "usedAt",
  u.used_by_user_id     AS "usedByUserId",
  u.reference,
  u.notes,
  u.stock_movement_id   AS "stockMovementId",
  u.created_at          AS "createdAt"
`;

/** Detail: every physical issue (usage) of the request — canonical order (newest first). */
async function listIssuesByMaterialRequest(
  materialRequestId: string,
): Promise<MobileMaterialIssueRow[]> {
  const result = await getPool().query<MobileMaterialIssueRow>(
    `SELECT ${ISSUE_SELECT}
     FROM inventory_work_order_material_usages u
     LEFT JOIN inventory_warehouses w ON w.id = u.warehouse_id
     WHERE u.material_request_id = $1
     ORDER BY u.used_at DESC, u.created_at DESC, u.id DESC`,
    [materialRequestId],
  );
  return result.rows;
}

/**
 * Item discovery for the field create command. The filter is EXACTLY the
 * validity rule `createMaterialRequest` enforces (item exists AND
 * item.client_id = Purchase Request client_id — i.e. the Work Order's client);
 * BE-17B does not gate on item status, so neither does discovery.
 */
async function listRequestableItemsByClient(clientId: string): Promise<MobileMaterialItemRow[]> {
  const result = await getPool().query<MobileMaterialItemRow>(
    `SELECT
       i.id        AS "itemId",
       i.code,
       i.name,
       i.item_type AS "itemType",
       i.uom_id    AS "uomId",
       u.code      AS "uomCode",
       u.name      AS "uomName",
       u.symbol    AS "uomSymbol"
     FROM inventory_items i
     LEFT JOIN units_of_measure u ON u.id = i.uom_id
     WHERE i.client_id = $1
     ORDER BY i.code ASC, i.id ASC`,
    [clientId],
  );
  return result.rows;
}

/** PART 03 — ids of ACTIVE reservations of one request (deterministic order). */
async function listActiveReservationIds(
  materialRequestId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<string[]> {
  const result = await executor.query<{ id: string }>(
    `SELECT id FROM inventory_material_reservations
     WHERE material_request_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at ASC, id ASC`,
    [materialRequestId],
  );
  return result.rows.map((r) => r.id);
}

/** PART 03 — one canonical issue row in the field projection (transaction-aware). */
async function findIssueById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<MobileMaterialIssueRow | null> {
  const result = await executor.query<MobileMaterialIssueRow>(
    `SELECT ${ISSUE_SELECT}
     FROM inventory_work_order_material_usages u
     LEFT JOIN inventory_warehouses w ON w.id = u.warehouse_id
     WHERE u.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export const mobileMaterialRequestRepository = {
  listActiveReservationIds,
  findIssueById,
  listByWorkOrder,
  findFieldById,
  listReservationsByMaterialRequest,
  listIssuesByMaterialRequest,
  listRequestableItemsByClient,
};
