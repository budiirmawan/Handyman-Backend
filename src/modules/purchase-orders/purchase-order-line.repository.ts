import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import type {
  NewPurchaseOrderLine,
  PurchaseOrderLineRecord,
  UpdatePurchaseOrderLineInput,
} from './purchase-order-line.types';

type PurchaseOrderLineRow = Omit<
  PurchaseOrderLineRecord,
  'quantitySnapshot' | 'unitPrice' | 'lineAmount'
> & {
  quantitySnapshot: string | null;
  unitPrice: string;
  lineAmount: string;
};

const SELECT = `
  id, purchase_order_id AS "purchaseOrderId",
  client_id AS "clientId", building_id AS "buildingId",
  line_number AS "lineNumber", request_line_type AS "requestLineType",
  material_request_id AS "materialRequestId",
  service_request_id AS "serviceRequestId",
  item_id AS "itemId", uom_id AS "uomId",
  source_service_id AS "sourceServiceId", description,
  quantity_snapshot::text AS "quantitySnapshot",
  unit_price::text AS "unitPrice",
  line_amount::text AS "lineAmount",
  notes, created_by_user_id AS "createdByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`.trim();

/** NUMERIC arrives as text; convert once, at the boundary. */
function mapRow(row: PurchaseOrderLineRow): PurchaseOrderLineRecord {
  return {
    ...row,
    quantitySnapshot:
      row.quantitySnapshot === null ? null : Number(row.quantitySnapshot),
    unitPrice: Number(row.unitPrice),
    lineAmount: Number(row.lineAmount),
  };
}

type HistoryAction = 'CREATED' | 'UPDATED' | 'REMOVED';

async function appendHistory(
  client: PoolClient,
  record: PurchaseOrderLineRecord,
  action: HistoryAction,
  actor: string,
): Promise<void> {
  await client.query(
    `INSERT INTO purchase_order_line_history
       (id, purchase_order_line_id, purchase_order_id, action, line_number,
        quantity_snapshot, unit_price, line_amount, notes, changed_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      record.id,
      record.purchaseOrderId,
      action,
      record.lineNumber,
      record.quantitySnapshot,
      record.unitPrice,
      record.lineAmount,
      record.notes,
      actor,
    ],
  );
}

/**
 * Inserts a line inside the caller's transaction.
 *
 * The line number is allocated under a lock on the parent Purchase Order row
 * so concurrent adds cannot collide on
 * `purchase_order_lines_po_line_number_unique`.
 */
async function createWithClient(
  client: PoolClient,
  input: Omit<NewPurchaseOrderLine, 'lineNumber'>,
): Promise<PurchaseOrderLineRecord> {
  await client.query('SELECT id FROM purchase_orders WHERE id = $1 FOR UPDATE', [
    input.purchaseOrderId,
  ]);

  const next = await client.query<{ lineNumber: number }>(
    `SELECT COALESCE(MAX(line_number), 0) + 1 AS "lineNumber"
     FROM purchase_order_lines WHERE purchase_order_id = $1`,
    [input.purchaseOrderId],
  );
  const lineNumber = Number(next.rows[0]?.lineNumber ?? 1);

  const result = await client.query<PurchaseOrderLineRow>(
    `INSERT INTO purchase_order_lines
       (id, purchase_order_id, client_id, building_id, line_number,
        request_line_type, material_request_id, service_request_id,
        item_id, uom_id, source_service_id, description, quantity_snapshot,
        unit_price, line_amount, notes, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.purchaseOrderId,
      input.clientId,
      input.buildingId,
      lineNumber,
      input.requestLineType,
      input.materialRequestId,
      input.serviceRequestId,
      input.itemId,
      input.uomId,
      input.sourceServiceId,
      input.description,
      input.quantitySnapshot,
      input.unitPrice,
      input.lineAmount,
      input.notes,
      input.createdByUserId,
    ],
  );

  const record = mapRow(result.rows[0]);
  await appendHistory(client, record, 'CREATED', input.createdByUserId);
  return record;
}

async function findById(id: string): Promise<PurchaseOrderLineRecord | null> {
  const result = await getPool().query<PurchaseOrderLineRow>(
    `SELECT ${SELECT} FROM purchase_order_lines WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Deterministic ordering: always by line number. */
async function listByPurchaseOrder(
  purchaseOrderId: string,
): Promise<PurchaseOrderLineRecord[]> {
  const result = await getPool().query<PurchaseOrderLineRow>(
    `SELECT ${SELECT} FROM purchase_order_lines
     WHERE purchase_order_id = $1
     ORDER BY line_number`,
    [purchaseOrderId],
  );
  return result.rows.map(mapRow);
}

/**
 * Existing commitments for a request line across ALL Purchase Orders,
 * excluding CANCELLED ones. Used to reject committing the same request line
 * on a second live Purchase Order (the per-PO unique constraints only guard
 * within one PO).
 */
async function findLiveCommitmentForRequestLine(
  materialRequestId: string | null,
  serviceRequestId: string | null,
  excludePurchaseOrderId?: string,
): Promise<PurchaseOrderLineRecord | null> {
  const values: unknown[] = [materialRequestId, serviceRequestId];
  let clause = '';
  if (excludePurchaseOrderId) {
    values.push(excludePurchaseOrderId);
    clause = ` AND purchase_order_id <> $${values.length}`;
  }
  const result = await getPool().query<PurchaseOrderLineRow>(
    `SELECT ${SELECT} FROM purchase_order_lines
     WHERE material_request_id IS NOT DISTINCT FROM $1
       AND service_request_id IS NOT DISTINCT FROM $2
       AND purchase_order_id IN (
         SELECT id FROM purchase_orders WHERE status <> 'CANCELLED'
       )${clause}
     LIMIT 1`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function update(
  id: string,
  input: UpdatePurchaseOrderLineInput,
  actor: string,
): Promise<PurchaseOrderLineRecord | null> {
  return withTransaction(async (client) => {
    const values: unknown[] = [];
    const sets: string[] = [];

    if (input.unitPrice !== undefined) {
      values.push(input.unitPrice);
      const pricePlaceholder = `$${values.length}`;
      sets.push(`unit_price = ${pricePlaceholder}`);
      // The committed amount always re-derives from the FROZEN snapshot; the
      // snapshot itself is never rewritten here. A service line has no
      // quantity, so its unit price IS the amount (COALESCE(..., 1)).
      sets.push(
        `line_amount = ROUND(COALESCE(quantity_snapshot, 1) * ${pricePlaceholder}::numeric, 2)`,
      );
    }
    if (input.description !== undefined) {
      values.push(input.description);
      sets.push(`description = $${values.length}`);
    }
    if (input.notes !== undefined) {
      values.push(input.notes);
      sets.push(`notes = $${values.length}`);
    }

    if (sets.length === 0) {
      const current = await client.query<PurchaseOrderLineRow>(
        `SELECT ${SELECT} FROM purchase_order_lines WHERE id = $1`,
        [id],
      );
      return current.rows[0] ? mapRow(current.rows[0]) : null;
    }

    values.push(id);
    sets.push('updated_at = NOW()');
    const result = await client.query<PurchaseOrderLineRow>(
      `UPDATE purchase_order_lines SET ${sets.join(', ')}
       WHERE id = $${values.length}
       RETURNING ${SELECT}`,
      values,
    );
    if (!result.rows[0]) return null;
    const record = mapRow(result.rows[0]);
    await appendHistory(client, record, 'UPDATED', actor);
    return record;
  });
}

/**
 * Removes a line after the service has verified its parent is DRAFT.
 *
 * The line and its cascaded line-history rows are deleted. The surviving audit
 * record is the `PURCHASE_ORDER_LINE_REMOVED` operational event emitted by the
 * service from the returned pre-delete snapshot.
 */
async function remove(id: string): Promise<PurchaseOrderLineRecord | null> {
  return withTransaction(async (client) => {
    const result = await client.query<PurchaseOrderLineRow>(
      `DELETE FROM purchase_order_lines WHERE id = $1
       RETURNING ${SELECT}`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  });
}

export const purchaseOrderLineRepository = {
  createWithClient,
  findById,
  findLiveCommitmentForRequestLine,
  listByPurchaseOrder,
  remove,
  update,
};
