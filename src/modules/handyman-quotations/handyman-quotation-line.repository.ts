import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanQuotationLineRecord,
  HandymanQuotationReferenceResolution,
} from './handyman-quotation.types';

/**
 * CR-HM-BE-03 RUN 2 — Quotation line persistence.
 *
 * Lines are the discriminated LABOR/MATERIAL/OTHER union (migration 0351
 * CHECKs); `line_total` is GENERATED (totals are derived from governed
 * lines, never caller-authoritative). Cross-aggregate authority (governed
 * service selections, catalog/item/UOM validation, reference-price
 * resolution) lives in the service; the composite same-client FKs are the
 * structural backstop.
 */

const LINE_SELECT = `
  id,
  quotation_revision_id AS "quotationRevisionId",
  quotation_id AS "quotationId",
  client_id AS "clientId",
  building_id AS "buildingId",
  line_number AS "lineNumber",
  line_type AS "lineType",
  service_catalog_id AS "serviceCatalogId",
  inventory_item_id AS "inventoryItemId",
  uom_id AS "uomId",
  quantity,
  subject_code AS "subjectCode",
  subject_name AS "subjectName",
  uom_code AS "uomCode",
  description,
  unit_price AS "unitPrice",
  line_total AS "lineTotal",
  reference_resolution AS "referenceResolution",
  reference_price_entry_id AS "referencePriceEntryId",
  reference_scope_tier AS "referenceScopeTier",
  reference_unit_price AS "referenceUnitPrice",
  reference_as_of AS "referenceAsOf",
  deviation_note AS "deviationNote",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create(
  input: {
    quotationRevisionId: string;
    quotationId: string;
    clientId: string;
    buildingId: string;
    lineNumber: number;
    lineType: string;
    serviceCatalogId: string | null;
    inventoryItemId: string | null;
    uomId: string | null;
    quantity: string | null;
    subjectCode: string | null;
    subjectName: string | null;
    uomCode: string | null;
    description: string | null;
    unitPrice: string;
    referenceResolution: HandymanQuotationReferenceResolution | null;
    referencePriceEntryId: string | null;
    referenceScopeTier: string | null;
    referenceUnitPrice: string | null;
    referenceAsOf: Date | null;
    deviationNote: string | null;
    createdByUserId: string;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationLineRecord> {
  const result = await executor.query<HandymanQuotationLineRecord>(
    `INSERT INTO handyman_quotation_lines
       (id, quotation_revision_id, quotation_id, client_id, building_id,
        line_number, line_type, service_catalog_id, inventory_item_id, uom_id,
        quantity, subject_code, subject_name, uom_code, description,
        unit_price, reference_resolution, reference_price_entry_id,
        reference_scope_tier, reference_unit_price, reference_as_of,
        deviation_note, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, $19, $20, $21, $22, $23)
     RETURNING ${LINE_SELECT}`,
    [
      randomUUID(),
      input.quotationRevisionId,
      input.quotationId,
      input.clientId,
      input.buildingId,
      input.lineNumber,
      input.lineType,
      input.serviceCatalogId,
      input.inventoryItemId,
      input.uomId,
      input.quantity,
      input.subjectCode,
      input.subjectName,
      input.uomCode,
      input.description,
      input.unitPrice,
      input.referenceResolution,
      input.referencePriceEntryId,
      input.referenceScopeTier,
      input.referenceUnitPrice,
      input.referenceAsOf,
      input.deviationNote,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationLineRecord | null> {
  const result = await executor.query<HandymanQuotationLineRecord>(
    `SELECT ${LINE_SELECT} FROM handyman_quotation_lines WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function listByRevision(
  quotationRevisionId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationLineRecord[]> {
  const result = await executor.query<HandymanQuotationLineRecord>(
    `SELECT ${LINE_SELECT} FROM handyman_quotation_lines
     WHERE quotation_revision_id = $1
     ORDER BY line_number ASC`,
    [quotationRevisionId],
  );
  return result.rows;
}

/**
 * Price/quantity/description update for a DRAFT-revision line. The subject
 * is immutable (delete + re-add under governance); provenance columns are
 * replaced wholesale because the service re-runs the reference-price
 * resolution on every price-affecting update.
 */
async function updateCommercialFacts(
  id: string,
  input: {
    unitPrice: string;
    quantity: string | null;
    description: string | null;
    referenceResolution: HandymanQuotationReferenceResolution | null;
    referencePriceEntryId: string | null;
    referenceScopeTier: string | null;
    referenceUnitPrice: string | null;
    referenceAsOf: Date | null;
    deviationNote: string | null;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationLineRecord | null> {
  const result = await executor.query<HandymanQuotationLineRecord>(
    `UPDATE handyman_quotation_lines
     SET unit_price = $2,
         quantity = $3,
         description = $4,
         reference_resolution = $5,
         reference_price_entry_id = $6,
         reference_scope_tier = $7,
         reference_unit_price = $8,
         reference_as_of = $9,
         deviation_note = $10,
         updated_at = NOW()
     WHERE id = $1
     RETURNING ${LINE_SELECT}`,
    [
      id,
      input.unitPrice,
      input.quantity,
      input.description,
      input.referenceResolution,
      input.referencePriceEntryId,
      input.referenceScopeTier,
      input.referenceUnitPrice,
      input.referenceAsOf,
      input.deviationNote,
    ],
  );
  return result.rows[0] ?? null;
}

/** Draft working-data removal; never allowed on SUBMITTED revisions. */
async function deleteById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    'DELETE FROM handyman_quotation_lines WHERE id = $1',
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

async function findMaxLineNumber(
  quotationRevisionId: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<number> {
  const result = await executor.query<{ max: string | null }>(
    `SELECT MAX(line_number)::TEXT AS max
     FROM handyman_quotation_lines
     WHERE quotation_revision_id = $1`,
    [quotationRevisionId],
  );
  return result.rows[0]?.max ? Number(result.rows[0].max) : 0;
}

/** Derived per-type totals + line count; SQL SUM only, never caller input. */
async function totalsByRevision(
  quotationRevisionId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<{
  laborTotal: string;
  materialTotal: string;
  otherTotal: string;
  grandTotal: string;
  lineCount: number;
}> {
  const result = await executor.query<{
    labor: string;
    material: string;
    other: string;
    grand: string;
    cnt: string;
  }>(
    `SELECT
       COALESCE(SUM(line_total) FILTER (WHERE line_type = 'LABOR'), 0)::TEXT AS labor,
       COALESCE(SUM(line_total) FILTER (WHERE line_type = 'MATERIAL'), 0)::TEXT AS material,
       COALESCE(SUM(line_total) FILTER (WHERE line_type = 'OTHER'), 0)::TEXT AS other,
       COALESCE(SUM(line_total), 0)::TEXT AS grand,
       COUNT(*)::TEXT AS cnt
     FROM handyman_quotation_lines
     WHERE quotation_revision_id = $1`,
    [quotationRevisionId],
  );
  const row = result.rows[0];
  return {
    laborTotal: row?.labor ?? '0',
    materialTotal: row?.material ?? '0',
    otherTotal: row?.other ?? '0',
    grandTotal: row?.grand ?? '0',
    lineCount: row ? Number(row.cnt) : 0,
  };
}

/** Same-client UOM existence lookup (composite FK is the structural backstop). */
async function findUnitOfMeasure(
  uomId: string,
  clientId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<{ id: string; code: string } | null> {
  const result = await executor.query<{ id: string; code: string }>(
    'SELECT id, code FROM units_of_measure WHERE id = $1 AND client_id = $2',
    [uomId, clientId],
  );
  return result.rows[0] ?? null;
}

export const handymanQuotationLineRepository = {
  create,
  findById,
  listByRevision,
  updateCommercialFacts,
  deleteById,
  findMaxLineNumber,
  totalsByRevision,
  findUnitOfMeasure,
};
