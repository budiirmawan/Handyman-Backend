import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  RfqAwardPoConversionRecord,
  RfqAwardPoLineProvenanceRecord,
} from './rfq-po-conversion.types';

type ConversionRow = RfqAwardPoConversionRecord;
type LineRow = RfqAwardPoLineProvenanceRecord;

const CONVERSION_SELECT = `
  id, award_id AS "awardId", recommendation_id AS "recommendationId",
  rfq_id AS "rfqId", client_id AS "clientId", building_id AS "buildingId",
  comparison_run_id AS "comparisonRunId", evidence_id AS "evidenceId",
  quotation_id AS "quotationId", quotation_revision_id AS "quotationRevisionId",
  invitation_id AS "invitationId", vendor_id AS "vendorId",
  po_readiness_id AS "poReadinessId", purchase_order_id AS "purchaseOrderId",
  idempotency_key AS "idempotencyKey", idempotency_fingerprint AS "idempotencyFingerprint",
  converted_by_user_id AS "convertedByUserId", converted_at AS "convertedAt"
`.trim();
const LINE_SELECT = `
  id, conversion_id AS "conversionId", purchase_order_id AS "purchaseOrderId",
  purchase_order_line_id AS "purchaseOrderLineId", rfq_id AS "rfqId",
  rfq_line_id AS "rfqLineId", quotation_line_id AS "quotationLineId",
  quotation_revision_id AS "quotationRevisionId", created_at AS "createdAt"
`.trim();

export async function isRfqDerivedPurchaseOrder(id: string): Promise<boolean> {
  const result = await getPool().query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM rfq_award_po_conversions WHERE purchase_order_id=$1) AS exists',
    [id],
  );
  return result.rows[0]?.exists === true;
}

export async function findConversionById(id: string): Promise<RfqAwardPoConversionRecord | null> {
  const result = await getPool().query<ConversionRow>(
    `SELECT ${CONVERSION_SELECT} FROM rfq_award_po_conversions WHERE id=$1`, [id],
  );
  return result.rows[0] ?? null;
}

export async function findConversionByIdForUpdate(client: PoolClient, id: string): Promise<RfqAwardPoConversionRecord | null> {
  const result = await client.query<ConversionRow>(
    `SELECT ${CONVERSION_SELECT} FROM rfq_award_po_conversions WHERE id=$1 FOR UPDATE`, [id],
  );
  return result.rows[0] ?? null;
}

export async function findConversionByAwardForUpdate(client: PoolClient, awardId: string): Promise<RfqAwardPoConversionRecord | null> {
  const result = await client.query<ConversionRow>(
    `SELECT ${CONVERSION_SELECT} FROM rfq_award_po_conversions WHERE award_id=$1 FOR UPDATE`, [awardId],
  );
  return result.rows[0] ?? null;
}

export async function findConversionByPurchaseOrder(id: string): Promise<RfqAwardPoConversionRecord | null> {
  const result = await getPool().query<ConversionRow>(
    `SELECT ${CONVERSION_SELECT} FROM rfq_award_po_conversions WHERE purchase_order_id=$1`, [id],
  );
  return result.rows[0] ?? null;
}

export async function createConversionWithClient(client: PoolClient, input: {
  awardId: string;
  recommendationId: string;
  rfqId: string;
  clientId: string;
  buildingId: string;
  comparisonRunId: string;
  evidenceId: string;
  quotationId: string;
  quotationRevisionId: string;
  invitationId: string;
  vendorId: string;
  poReadinessId: string;
  purchaseOrderId: string;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  convertedByUserId: string;
}): Promise<RfqAwardPoConversionRecord> {
  const result = await client.query<ConversionRow>(
    `INSERT INTO rfq_award_po_conversions
       (id,award_id,recommendation_id,rfq_id,client_id,building_id,comparison_run_id,
        evidence_id,quotation_id,quotation_revision_id,invitation_id,vendor_id,
        po_readiness_id,purchase_order_id,idempotency_key,idempotency_fingerprint,
        converted_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING ${CONVERSION_SELECT}`,
    [randomUUID(), input.awardId, input.recommendationId, input.rfqId, input.clientId,
      input.buildingId, input.comparisonRunId, input.evidenceId, input.quotationId,
      input.quotationRevisionId, input.invitationId, input.vendorId, input.poReadinessId,
      input.purchaseOrderId, input.idempotencyKey, input.idempotencyFingerprint,
      input.convertedByUserId],
  );
  return result.rows[0];
}

export async function createLineProvenanceWithClient(client: PoolClient, input: {
  conversionId: string;
  purchaseOrderId: string;
  purchaseOrderLineId: string;
  rfqId: string;
  rfqLineId: string;
  quotationLineId: string;
  quotationRevisionId: string;
}): Promise<RfqAwardPoLineProvenanceRecord> {
  const result = await client.query<LineRow>(
    `INSERT INTO rfq_award_po_line_provenance
       (id,conversion_id,purchase_order_id,purchase_order_line_id,rfq_id,rfq_line_id,
        quotation_line_id,quotation_revision_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${LINE_SELECT}`,
    [randomUUID(), input.conversionId, input.purchaseOrderId, input.purchaseOrderLineId,
      input.rfqId, input.rfqLineId, input.quotationLineId, input.quotationRevisionId],
  );
  return result.rows[0];
}

export async function listLineProvenance(conversionId: string): Promise<RfqAwardPoLineProvenanceRecord[]> {
  const result = await getPool().query<LineRow>(
    `SELECT ${LINE_SELECT} FROM rfq_award_po_line_provenance WHERE conversion_id=$1 ORDER BY rfq_line_id`,
    [conversionId],
  );
  return result.rows;
}

export const rfqPoProvenanceRepository = {
  createConversionWithClient,
  createLineProvenanceWithClient,
  findConversionByAwardForUpdate,
  findConversionById,
  findConversionByIdForUpdate,
  findConversionByPurchaseOrder,
  isRfqDerivedPurchaseOrder,
  listLineProvenance,
};
