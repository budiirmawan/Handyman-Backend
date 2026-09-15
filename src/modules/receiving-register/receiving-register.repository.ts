import { getPool } from '../../database';
import type {
  PublicReceivingRegisterRow,
  ReceivingRegisterFilters,
} from './receiving-register.types';

/**
 * R11 PART 01 — Receiving Register repository.
 *
 * One read-only statement over the existing authoritative `receivings`
 * table. Grain is exactly one row per receivings row: there are NO joins
 * at all, so no fan-out is structurally possible and no second authority
 * is consulted. Every projected column is a persisted fact of the row.
 *
 * NO PURCHASE ORDER INFERENCE. The schema carries no receiving →
 * purchase_order or purchase_order_line reference (verified across
 * migrations 0182/0264/0266), and none is derived here by vendor,
 * readiness, item, quantity, request, timestamp or live-PO coincidence.
 * The register is request-anchored through the row's own persisted
 * purchase_request_id / service_request_id / material_request_id columns.
 *
 * NO MONETARY COLUMN is selected: receivings persists none, and this read
 * model adds none.
 *
 * DATE WINDOW — applied to `receivings.received_at` (the business period
 * authority) as a half-open [start, end) range, mirroring the BE-23H /
 * CR-BE-REPORT-READ-01 register convention. `created_at` / `updated_at`
 * are never period substitutes and are not selected at all.
 *
 * ORDERING — `received_at DESC, id DESC`: the DESC direction is the
 * receivings module's own list ordering (receiving.repository.ts list
 * queries ORDER BY received_at DESC); the `id` tiebreak only makes the
 * ordering deterministic. No business ranking is invented.
 *
 * ISOLATION — `receivings.building_id` (derived authoritatively from the
 * referenced request by BE-17G) is the isolation column and the FIRST
 * condition, exactly as in the vendor-service-register read: the query is
 * structurally restricted to the caller's authorized Building set, with no
 * all-client fallback. No writes, no ETL, no new tables.
 */

type RegisterRow = {
  receiving_id: string;
  client_id: string;
  building_id: string;
  request_type: string;
  purchase_request_id: string | null;
  service_request_id: string | null;
  material_request_id: string | null;
  vendor_id: string;
  receiving_type: string;
  item_id: string | null;
  warehouse_id: string | null;
  quantity: string | null;
  uom_id: string | null;
  stock_movement_id: string | null;
  received_by_user_id: string;
  received_at: Date;
  status: string;
  notes: string | null;
};

function mapRow(row: RegisterRow): PublicReceivingRegisterRow {
  return {
    receivingId: row.receiving_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    requestType: row.request_type,
    purchaseRequestId: row.purchase_request_id,
    serviceRequestId: row.service_request_id,
    materialRequestId: row.material_request_id,
    vendorId: row.vendor_id,
    receivingType: row.receiving_type,
    itemId: row.item_id,
    warehouseId: row.warehouse_id,
    // NUMERIC arrives as string from pg; the receivings domain's own
    // mapper (receiving.repository.ts mapRow) converts with Number() and
    // preserves NULL — mirrored verbatim, no rounding, no arithmetic.
    quantity: row.quantity === null ? null : Number(row.quantity),
    uomId: row.uom_id,
    stockMovementId: row.stock_movement_id,
    receivedByUserId: row.received_by_user_id,
    receivedAt: row.received_at.toISOString(),
    status: row.status,
    notes: row.notes,
  };
}

export async function getReceivingRegisterRows(
  buildingIds: string[],
  filters: ReceivingRegisterFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicReceivingRegisterRow[]> {
  const conditions: string[] = ['r.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.vendorId) {
    values.push(filters.vendorId);
    conditions.push(`r.vendor_id = $${values.length}`);
  }
  if (filters.receivingType) {
    values.push(filters.receivingType);
    conditions.push(`r.receiving_type = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`r.status = $${values.length}`);
  }
  if (filters.purchaseRequestId) {
    values.push(filters.purchaseRequestId);
    conditions.push(`r.purchase_request_id = $${values.length}`);
  }
  if (filters.serviceRequestId) {
    values.push(filters.serviceRequestId);
    conditions.push(`r.service_request_id = $${values.length}`);
  }
  if (filters.materialRequestId) {
    values.push(filters.materialRequestId);
    conditions.push(`r.material_request_id = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`r.received_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`r.received_at < $${values.length}`);
  }

  const result = await getPool().query<RegisterRow>(
    `SELECT
       r.id AS receiving_id,
       r.client_id AS client_id,
       r.building_id AS building_id,
       r.request_type AS request_type,
       r.purchase_request_id AS purchase_request_id,
       r.service_request_id AS service_request_id,
       r.material_request_id AS material_request_id,
       r.vendor_id AS vendor_id,
       r.receiving_type AS receiving_type,
       r.item_id AS item_id,
       r.warehouse_id AS warehouse_id,
       r.quantity AS quantity,
       r.uom_id AS uom_id,
       r.stock_movement_id AS stock_movement_id,
       r.received_by_user_id AS received_by_user_id,
       r.received_at AS received_at,
       r.status AS status,
       r.notes AS notes
     FROM receivings r
     WHERE ${conditions.join(' AND ')}
     ORDER BY r.received_at DESC, r.id DESC`,
    values,
  );

  return result.rows.map(mapRow);
}

export const receivingRegisterRepository = {
  getReceivingRegisterRows,
};
