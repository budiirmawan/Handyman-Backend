import { getPool } from '../../database';
import type {
  PublicStockMovementRegisterRow,
  StockMovementRegisterFilters,
} from './stock-movement-register.types';

/**
 * R11 PART 05B — Stock Movement Register repository.
 *
 * Exactly ONE read-only set-based statement over the existing authoritative
 * `inventory_stock_movements` table (migration 0169 + the 0266 UOM snapshot
 * column). Grain is exactly one row per movement row: there are ZERO joins,
 * so no fan-out is structurally possible and no second authority is
 * consulted. Every projected column is a persisted fact of the movement
 * row — no warehouse/item display names, no nested resolved-balance object,
 * no derived reserved quantity, no balance arithmetic of any kind.
 *
 * ISOLATION — `movement.building_id` is the isolation column and the FIRST
 * structural condition, exactly as in the receiving-register and
 * purchase-order-line-register reads: the query is structurally restricted
 * to the caller's authorized Building set (`= ANY($1::uuid[])`), with no
 * all-client fallback and no caller-supplied client predicate. `client_id`
 * is selected only as a verbatim row fact. Each movement row persists its
 * own client/building denormalization (migration 0169), so no join is
 * needed for isolation. An empty authorized Building set fail-closes to an
 * empty result BEFORE any SQL is built or issued.
 *
 * DATE WINDOW — the half-open [start, end) BE-23H convention applied to
 * `movement_date` (TIMESTAMPTZ), the movement business period authority:
 * `>= start-of-dateFrom UTC` and `< start-of-day-after-dateTo UTC`, so the
 * entire `dateTo` calendar day is included. The `<= dateTo-midnight`
 * truncation defect of the existing public list is deliberately NOT
 * reproduced. `created_at` is never a period substitute; it is selected
 * only as a verbatim audit fact (the table has no updated-at column —
 * movements are immutable).
 *
 * OPTIONAL FILTERS — structural equality over the movement row's own
 * persisted warehouse/item/actor ids and native movement type, plus the
 * owning domain's own reference-filter semantics (case-insensitive
 * substring over the movement's own persisted `reference` text, mirroring
 * the movements repository list). Every value arrives pre-validated from
 * the governed service parser.
 *
 * NO MONETARY COLUMN is selected: the movements table persists none, and
 * this read model adds none. NO reverse-relationship enrichment: domains
 * that persist a movement id (receivings, work-order material usages) are
 * never joined back. NO reshaping — no CASE, no DISTINCT, no GROUP BY, no
 * ROW_NUMBER, no aggregate, no LIMIT-based current/latest selector, no
 * post-query filter and no post-query sort.
 *
 * ORDERING — `movement_date DESC, created_at DESC, id DESC`: the DESC
 * direction is the movements module's own list ordering; the trailing keys
 * only make the ordering fully deterministic. No business ranking is
 * invented.
 *
 * NUMERIC boundary — the three NUMERIC columns arrive as text from pg and
 * are converted once with `Number()`, mirroring the owning movements
 * repository's own mapper convention verbatim. No rounding, no arithmetic.
 */

type MovementRow = {
  stock_movement_id: string;
  client_id: string;
  building_id: string;
  warehouse_id: string;
  item_id: string;
  movement_type: string;
  quantity: string;
  uom_id: string | null;
  movement_date: Date;
  reference: string | null;
  source: string | null;
  performed_by_user_id: string;
  notes: string | null;
  resulting_quantity_on_hand: string;
  resulting_available_quantity: string;
  created_at: Date;
};

function mapRow(row: MovementRow): PublicStockMovementRegisterRow {
  return {
    // The movement's own identity, explicitly named for the public
    // contract — the only rename on the row.
    stockMovementId: row.stock_movement_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    warehouseId: row.warehouse_id,
    itemId: row.item_id,
    // Native discriminator copied verbatim; never reshaped, never
    // normalized to any other vocabulary.
    movementType: row.movement_type,
    quantity: Number(row.quantity),
    uomId: row.uom_id,
    movementDate: row.movement_date.toISOString(),
    reference: row.reference,
    source: row.source,
    performedByUserId: row.performed_by_user_id,
    notes: row.notes,
    // Persisted HISTORICAL post-movement snapshots — copied column-for-
    // column with the single Number() boundary conversion. No subtraction,
    // no reserved-quantity derivation, no current-balance resolution.
    resultingQuantityOnHand: Number(row.resulting_quantity_on_hand),
    resultingAvailableQuantity: Number(row.resulting_available_quantity),
    createdAt: row.created_at.toISOString(),
  };
}

export async function getStockMovementRegisterRows(
  buildingIds: string[],
  filters: StockMovementRegisterFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicStockMovementRegisterRow[]> {
  // Fail closed: an empty authorized Building set never reaches SQL.
  if (buildingIds.length === 0) return [];

  const conditions: string[] = ['movement.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.warehouseId) {
    values.push(filters.warehouseId);
    conditions.push(`movement.warehouse_id = $${values.length}`);
  }
  if (filters.itemId) {
    values.push(filters.itemId);
    conditions.push(`movement.item_id = $${values.length}`);
  }
  if (filters.movementType) {
    values.push(filters.movementType);
    conditions.push(`movement.movement_type = $${values.length}`);
  }
  if (filters.performedByUserId) {
    values.push(filters.performedByUserId);
    conditions.push(`movement.performed_by_user_id = $${values.length}`);
  }
  if (filters.reference) {
    // The owning domain's own reference-filter semantics, preserved:
    // case-insensitive substring over the movement's persisted reference.
    values.push(`%${filters.reference}%`);
    conditions.push(`movement.reference ILIKE $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`movement.movement_date >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`movement.movement_date < $${values.length}`);
  }

  const result = await getPool().query<MovementRow>(
    `SELECT
       movement.id AS stock_movement_id,
       movement.client_id AS client_id,
       movement.building_id AS building_id,
       movement.warehouse_id AS warehouse_id,
       movement.item_id AS item_id,
       movement.movement_type AS movement_type,
       movement.quantity AS quantity,
       movement.uom_id AS uom_id,
       movement.movement_date AS movement_date,
       movement.reference AS reference,
       movement.source AS source,
       movement.performed_by_user_id AS performed_by_user_id,
       movement.notes AS notes,
       movement.resulting_quantity_on_hand AS resulting_quantity_on_hand,
       movement.resulting_available_quantity AS resulting_available_quantity,
       movement.created_at AS created_at
     FROM inventory_stock_movements movement
     WHERE ${conditions.join(' AND ')}
     ORDER BY movement.movement_date DESC, movement.created_at DESC,
              movement.id DESC`,
    values,
  );

  return result.rows.map(mapRow);
}

export const stockMovementRegisterRepository = {
  getStockMovementRegisterRows,
};
