import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanQuotationLineRecord,
  NewHandymanQuotationLine,
} from './handyman-quotation-line.types';

/**
 * CR-HM-06 PART 02 — quotation line repository (FROZEN F4). Executor-
 * first; INSERT + bounded reads ONLY. No UPDATE/DELETE exists (0392
 * trigger is the DB backstop for the immutable commercial snapshot).
 */

type LineRow = {
  id: string;
  quotation_version_id: string;
  line_type: HandymanQuotationLineRecord['lineType'];
  description: string;
  quantity: string;
  uom_id: string;
  reference_unit_amount: string | null;
  final_quoted_unit_amount: string;
  line_total: string;
  currency: HandymanQuotationLineRecord['currency'];
  source_item_id: string | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const LINE_SELECT = `
  SELECT id, quotation_version_id, line_type, description, quantity,
         uom_id, reference_unit_amount, final_quoted_unit_amount,
         line_total, currency, source_item_id, created_by_user_id,
         created_at, updated_at
    FROM handyman_quotation_lines`;

function mapLine(row: LineRow): HandymanQuotationLineRecord {
  return {
    id: row.id,
    quotationVersionId: row.quotation_version_id,
    lineType: row.line_type,
    description: row.description,
    quantity: Number(row.quantity),
    uomId: row.uom_id,
    referenceUnitAmount:
      row.reference_unit_amount === null
        ? null
        : Number(row.reference_unit_amount),
    finalQuotedUnitAmount: Number(row.final_quoted_unit_amount),
    lineTotal: Number(row.line_total),
    currency: row.currency,
    sourceItemId: row.source_item_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * line_total is computed inside the INSERT (server/DB authority only):
 * ROUND(quantity * final_quoted_unit_amount, 2), independently enforced
 * by the 0392 CHECK.
 */
async function insertLine(
  executor: Pick<PoolClient, 'query'>,
  input: NewHandymanQuotationLine,
): Promise<HandymanQuotationLineRecord> {
  const result = await executor.query<LineRow>(
    `INSERT INTO handyman_quotation_lines (
       id, quotation_version_id, line_type, description, quantity,
       uom_id, reference_unit_amount, final_quoted_unit_amount,
       line_total, currency, source_item_id, created_by_user_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       ROUND($5::numeric * $8::numeric, 2), $9, $10, $11
     )
     RETURNING id, quotation_version_id, line_type, description, quantity,
               uom_id, reference_unit_amount, final_quoted_unit_amount,
               line_total, currency, source_item_id, created_by_user_id,
               created_at, updated_at`,
    [
      randomUUID(),
      input.quotationVersionId,
      input.lineType,
      input.description,
      input.quantity,
      input.uomId,
      input.referenceUnitAmount,
      input.finalQuotedUnitAmount,
      input.currency,
      input.sourceItemId,
      input.createdByUserId,
    ],
  );
  return mapLine(result.rows[0]);
}

async function listLines(
  executor: Pick<PoolClient, 'query'> = getPool(),
  quotationVersionId: string,
): Promise<HandymanQuotationLineRecord[]> {
  const result = await executor.query<LineRow>(
    `${LINE_SELECT} WHERE quotation_version_id = $1
     ORDER BY created_at ASC, id ASC`,
    [quotationVersionId],
  );
  return result.rows.map(mapLine);
}

/** The version currency, if any line exists (one-currency rule). */
async function findVersionCurrency(
  executor: Pick<PoolClient, 'query'> = getPool(),
  quotationVersionId: string,
): Promise<string | null> {
  const result = await executor.query<{ currency: string }>(
    `SELECT DISTINCT currency FROM handyman_quotation_lines
      WHERE quotation_version_id = $1`,
    [quotationVersionId],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].currency;
}

/** Derived per-type subtotals (never persisted). */
async function sumLines(
  executor: Pick<PoolClient, 'query'> = getPool(),
  quotationVersionId: string,
): Promise<{ labor: number; material: number; count: number }> {
  const result = await executor.query<{
    labor: string | null;
    material: string | null;
    count: string;
  }>(
    `SELECT
       COALESCE(SUM(line_total) FILTER (WHERE line_type = 'LABOR'), 0) AS labor,
       COALESCE(SUM(line_total) FILTER (WHERE line_type = 'MATERIAL'), 0)
         AS material,
       COUNT(*)::int AS count
     FROM handyman_quotation_lines
     WHERE quotation_version_id = $1`,
    [quotationVersionId],
  );
  const row = result.rows[0];
  return {
    labor: Number(row.labor ?? 0),
    material: Number(row.material ?? 0),
    count: Number(row.count),
  };
}

/** Client-scoped UOM membership check (units_of_measure master). */
async function uomBelongsToClient(
  executor: Pick<PoolClient, 'query'>,
  uomId: string,
  clientId: string,
): Promise<boolean> {
  const result = await executor.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE id = $1 AND client_id = $2`,
    [uomId, clientId],
  );
  return result.rows.length > 0;
}

/** Client-scoped inventory item existence (MATERIAL provenance). */
async function itemBelongsToClient(
  executor: Pick<PoolClient, 'query'>,
  itemId: string,
  clientId: string,
): Promise<boolean> {
  const result = await executor.query<{ id: string }>(
    `SELECT id FROM inventory_items WHERE id = $1 AND client_id = $2`,
    [itemId, clientId],
  );
  return result.rows.length > 0;
}

export const handymanQuotationLineRepository = {
  insertLine,
  listLines,
  findVersionCurrency,
  sumLines,
  uomBelongsToClient,
  itemBelongsToClient,
};
