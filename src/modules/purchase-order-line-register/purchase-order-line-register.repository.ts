import { getPool } from '../../database';
import type {
  PublicPurchaseOrderLineRegisterRow,
  PurchaseOrderLineRegisterFilters,
} from './purchase-order-line-register.types';

/**
 * R11 PART 03B — Purchase Order Line Register repository.
 *
 * EXACTLY ONE read-only, set-based statement produces the whole register
 * across every authorized Building: `purchase_order_lines` joined to its
 * owning `purchase_orders` header. There is no per-PO loop, no second
 * query, no N+1 — this repository exists precisely because the
 * purchase-orders module's public line read is per-PO and a cross-PO
 * register built on it would require list → loop → fetch.
 *
 * PARENT JOIN — structurally safe, not UUID coincidence alone. Both tables
 * carry client/building scope columns (the line's are derived from the
 * parent at commit time and never client-supplied), so the join requires
 * full structural equality:
 *
 *   po.id          = line.purchase_order_id
 *   po.client_id   = line.client_id
 *   po.building_id = line.building_id
 *
 * `purchase_orders.id` is the primary key, so the join is 1:1 — no fan-out,
 * no row multiplication, no collapse. The header is joined READ-ONLY for
 * parent context (vendorId, purchaseRequestId, poNumber, poDate, currency,
 * purchaseOrderStatus) and for the period/status/vendor/request filters;
 * NO header list, header projection or second header read model is created
 * here — the HEADER view stays owned by the purchase-orders module.
 *
 * ISOLATION — `line.building_id = ANY($1::uuid[])` is the FIRST condition:
 * the query is structurally restricted to the caller's authorized Building
 * set (resolved by the service through context-access), with no
 * caller-supplied clientId, no all-client fallback and no unscoped path.
 *
 * PERIOD — the parent PO's `po_date` (DATE) filtered INCLUSIVE on both
 * ends (`>= dateFrom::date`, `<= dateTo::date`), identical in meaning to
 * the HEADER authority's own window. `line.created_at` / `po.created_at` /
 * `updated_at` are never period filters; they are selected only as
 * verbatim audit facts.
 *
 * NO ENRICHMENT — no RFQ, price-catalog, price-deviation, receiving,
 * vendor-invoice, SPK or work-order table is joined. NO ARITHMETIC — no
 * SUM, no quantity × price recomputation, no rounding: the three NUMERIC
 * columns arrive as text from pg and are converted once with `Number()` at
 * the boundary, mirroring the purchase-orders line repository's own
 * `mapRow` convention.
 *
 * NO RESHAPING — no WHERE-side CASE, no DISTINCT, no GROUP BY, no
 * ROW_NUMBER, no LIMIT-based current/latest selector, no post-query filter
 * and no post-query sort.
 *
 * ORDERING — `po.po_date DESC, line.purchase_order_id ASC,
 * line.line_number ASC, line.id ASC`: the DESC direction mirrors the
 * purchase-orders module's own header list ordering (`po_date DESC`);
 * the remaining keys only make the ordering fully deterministic within a
 * date. No business ranking is implied.
 */

type RegisterRow = {
  purchase_order_line_id: string;
  purchase_order_id: string;
  client_id: string;
  building_id: string;
  vendor_id: string;
  purchase_request_id: string | null;
  po_number: string;
  po_date: string;
  currency: string;
  purchase_order_status: string;
  line_number: number;
  request_line_type: string;
  material_request_id: string | null;
  service_request_id: string | null;
  item_id: string | null;
  uom_id: string | null;
  source_service_id: string | null;
  description: string;
  quantity_snapshot: string | null;
  unit_price: string;
  line_amount: string;
  notes: string | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

function mapRow(row: RegisterRow): PublicPurchaseOrderLineRegisterRow {
  return {
    // The line's own identity, explicitly named for the public contract.
    purchaseOrderLineId: row.purchase_order_line_id,
    // Parent context — every value copied verbatim from the joined header.
    purchaseOrderId: row.purchase_order_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    vendorId: row.vendor_id,
    purchaseRequestId: row.purchase_request_id,
    poNumber: row.po_number,
    poDate: row.po_date,
    currency: row.currency,
    purchaseOrderStatus: row.purchase_order_status,
    // Line facts — verbatim; the discriminator is the persisted column,
    // never inferred from which nullable field happens to be set.
    lineNumber: row.line_number,
    requestLineType: row.request_line_type,
    materialRequestId: row.material_request_id,
    serviceRequestId: row.service_request_id,
    itemId: row.item_id,
    uomId: row.uom_id,
    sourceServiceId: row.source_service_id,
    description: row.description,
    // NUMERIC arrives as text from pg; converted once with Number() and
    // NULL preserved (SERVICE lines keep quantitySnapshot NULL). No
    // rounding, no arithmetic, no recomputation of lineAmount.
    quantitySnapshot:
      row.quantity_snapshot === null ? null : Number(row.quantity_snapshot),
    unitPrice: Number(row.unit_price),
    lineAmount: Number(row.line_amount),
    notes: row.notes,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getPurchaseOrderLineRegisterRows(
  buildingIds: string[],
  filters: PurchaseOrderLineRegisterFilters,
): Promise<PublicPurchaseOrderLineRegisterRow[]> {
  // Fail-closed: an empty authorized scope never reaches the database.
  if (buildingIds.length === 0) return [];

  const conditions: string[] = ['line.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`line.building_id = $${values.length}`);
  }
  if (filters.vendorId) {
    values.push(filters.vendorId);
    conditions.push(`po.vendor_id = $${values.length}`);
  }
  if (filters.purchaseRequestId) {
    values.push(filters.purchaseRequestId);
    conditions.push(`po.purchase_request_id = $${values.length}`);
  }
  if (filters.serviceRequestId) {
    // The LINE's own originating Service Request — matches the published
    // field (see the filter contract in the types file).
    values.push(filters.serviceRequestId);
    conditions.push(`line.service_request_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`po.status = $${values.length}`);
  }
  if (filters.materialRequestId) {
    values.push(filters.materialRequestId);
    conditions.push(`line.material_request_id = $${values.length}`);
  }
  if (filters.itemId) {
    values.push(filters.itemId);
    conditions.push(`line.item_id = $${values.length}`);
  }
  // Inclusive calendar-date window over the parent PO's business date —
  // the ONLY period filter. Never line.created_at, po.created_at or
  // updated_at.
  if (filters.dateFrom) {
    values.push(filters.dateFrom);
    conditions.push(`po.po_date >= $${values.length}::date`);
  }
  if (filters.dateTo) {
    values.push(filters.dateTo);
    conditions.push(`po.po_date <= $${values.length}::date`);
  }

  const result = await getPool().query<RegisterRow>(
    `SELECT
       line.id AS purchase_order_line_id,
       line.purchase_order_id AS purchase_order_id,
       line.client_id AS client_id,
       line.building_id AS building_id,
       po.vendor_id AS vendor_id,
       po.purchase_request_id AS purchase_request_id,
       po.po_number AS po_number,
       po.po_date::text AS po_date,
       po.currency AS currency,
       po.status AS purchase_order_status,
       line.line_number AS line_number,
       line.request_line_type AS request_line_type,
       line.material_request_id AS material_request_id,
       line.service_request_id AS service_request_id,
       line.item_id AS item_id,
       line.uom_id AS uom_id,
       line.source_service_id AS source_service_id,
       line.description AS description,
       line.quantity_snapshot AS quantity_snapshot,
       line.unit_price AS unit_price,
       line.line_amount AS line_amount,
       line.notes AS notes,
       line.created_by_user_id AS created_by_user_id,
       line.created_at AS created_at,
       line.updated_at AS updated_at
     FROM purchase_order_lines line
     JOIN purchase_orders po
       ON po.id = line.purchase_order_id
      AND po.client_id = line.client_id
      AND po.building_id = line.building_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY po.po_date DESC, line.purchase_order_id ASC,
              line.line_number ASC, line.id ASC`,
    values,
  );

  return result.rows.map(mapRow);
}

export const purchaseOrderLineRegisterRepository = {
  getPurchaseOrderLineRegisterRows,
};
