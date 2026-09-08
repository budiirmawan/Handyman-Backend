import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  CreateRfqEvaluationInput,
  RfqComparisonAttachmentReference,
  RfqComparisonEvidenceRecord,
  RfqComparisonEvaluationRecord,
  RfqComparisonLineRecord,
  RfqComparisonRunRecord,
  UpdateRfqEvaluationInput,
} from './rfq-comparison.types';

type RunRow = RfqComparisonRunRecord;
type EvidenceRow = RfqComparisonEvidenceRecord;
type LineRow = Omit<
  RfqComparisonLineRecord,
  | 'requiredQuantitySnapshot'
  | 'quotedQuantitySnapshot'
  | 'unitPrice'
  | 'lineTotal'
  | 'reference'
> & {
  requiredQuantitySnapshot: string | number | null;
  quotedQuantitySnapshot: string | number | null;
  unitPrice: string | number;
  lineTotal: string | number;
  referencePriceEntryId: string | null;
  referenceUnitPrice: string | number | null;
  referenceCurrency: string | null;
  referenceUomId: string | null;
  referenceScopeVendor: boolean | null;
  referenceScopeBuilding: boolean | null;
  referenceEffectiveFrom: Date | null;
  referenceResolution: RfqComparisonLineRecord['reference']['resolution'];
  referenceTotal: string | number | null;
  unitVariance: string | number | null;
  totalVariance: string | number | null;
  variancePercent: string | number | null;
  positionVsReference: RfqComparisonLineRecord['reference']['position'];
};
type AttachmentRow = RfqComparisonAttachmentReference;
type EvaluationRow = RfqComparisonEvaluationRecord;

const RUN_SELECT = `
  id, rfq_id AS "rfqId", client_id AS "clientId", building_id AS "buildingId",
  source_mode AS "sourceMode", currency, rfq_number_snapshot AS "rfqNumberSnapshot",
  status, snapshot_at AS "snapshotAt", created_by_user_id AS "createdByUserId",
  idempotency_key AS "idempotencyKey", idempotency_fingerprint AS "idempotencyFingerprint",
  created_at AS "createdAt"
`.trim();

const EVIDENCE_SELECT = `
  id, comparison_run_id AS "comparisonRunId", rfq_id AS "rfqId",
  invitation_id AS "invitationId", quotation_id AS "quotationId",
  quotation_revision_id AS "quotationRevisionId", vendor_id AS "vendorId",
  client_id AS "clientId", building_id AS "buildingId",
  quotation_number_snapshot AS "quotationNumberSnapshot",
  revision_number_snapshot AS "revisionNumberSnapshot", submitted_at AS "submittedAt",
  currency, valid_until::text AS "validUntil", lead_time_days AS "leadTimeDays",
  delivery_terms AS "deliveryTerms", service_terms AS "serviceTerms", notes,
  total_amount AS "totalAmount", created_at AS "createdAt"
`.trim();

const LINE_SELECT = `
  id, comparison_run_id AS "comparisonRunId", evidence_id AS "evidenceId",
  rfq_id AS "rfqId", rfq_line_id AS "rfqLineId", quotation_line_id AS "quotationLineId",
  source_mode AS "sourceMode", rfq_line_number_snapshot AS "rfqLineNumberSnapshot",
  description_snapshot AS "descriptionSnapshot",
  offered_description_snapshot AS "offeredDescriptionSnapshot",
  required_quantity_snapshot AS "requiredQuantitySnapshot",
  required_uom_id AS "requiredUomId", quoted_quantity_snapshot AS "quotedQuantitySnapshot",
  unit_price AS "unitPrice", line_total AS "lineTotal",
  technical_compliance AS "technicalCompliance", deviation_notes AS "deviationNotes",
  line_status AS "lineStatus",
  reference_price_entry_id AS "referencePriceEntryId",
  reference_unit_price AS "referenceUnitPrice",
  reference_currency AS "referenceCurrency",
  reference_uom_id AS "referenceUomId",
  reference_scope_vendor AS "referenceScopeVendor",
  reference_scope_building AS "referenceScopeBuilding",
  reference_effective_from AS "referenceEffectiveFrom",
  reference_resolution AS "referenceResolution",
  reference_total AS "referenceTotal",
  unit_variance AS "unitVariance",
  total_variance AS "totalVariance",
  variance_percent AS "variancePercent",
  position_vs_reference AS "positionVsReference",
  created_at AS "createdAt"
`.trim();

const ATTACHMENT_SELECT = `
  id, comparison_run_id AS "comparisonRunId", evidence_id AS "evidenceId",
  supporting_document_id AS "supportingDocumentId", document_id AS "documentId",
  created_at AS "createdAt"
`.trim();

const EVALUATION_SELECT = `
  id, comparison_run_id AS "comparisonRunId", evidence_id AS "evidenceId",
  rfq_id AS "rfqId", vendor_id AS "vendorId",
  quotation_revision_id AS "quotationRevisionId",
  commercial_observation AS "commercialObservation",
  technical_observation AS "technicalObservation",
  compliance_observation AS "complianceObservation",
  evaluator_note AS "evaluatorNote", created_by_user_id AS "createdByUserId",
  updated_by_user_id AS "updatedByUserId", created_at AS "createdAt",
  updated_at AS "updatedAt"
`.trim();

function mapRun(row: RunRow): RfqComparisonRunRecord { return row; }
function mapEvidence(row: EvidenceRow): RfqComparisonEvidenceRecord {
  return { ...row, totalAmount: Number(row.totalAmount) };
}
function mapLine(row: LineRow): RfqComparisonLineRecord {
  const {
    referencePriceEntryId,
    referenceUnitPrice,
    referenceCurrency,
    referenceUomId,
    referenceScopeVendor,
    referenceScopeBuilding,
    referenceEffectiveFrom,
    referenceResolution,
    referenceTotal,
    unitVariance,
    totalVariance,
    variancePercent,
    positionVsReference,
    ...base
  } = row;
  const nullableNumber = (value: string | number | null): number | null =>
    value === null ? null : Number(value);
  return {
    ...base,
    requiredQuantitySnapshot: row.requiredQuantitySnapshot === null ? null : Number(row.requiredQuantitySnapshot),
    quotedQuantitySnapshot: row.quotedQuantitySnapshot === null ? null : Number(row.quotedQuantitySnapshot),
    unitPrice: Number(row.unitPrice),
    lineTotal: Number(row.lineTotal),
    reference: {
      priceEntryId: referencePriceEntryId,
      unitPrice: nullableNumber(referenceUnitPrice),
      currency: referenceCurrency,
      uomId: referenceUomId,
      scopeVendor: referenceScopeVendor,
      scopeBuilding: referenceScopeBuilding,
      effectiveFrom: referenceEffectiveFrom,
      resolution: referenceResolution,
      referenceTotal: nullableNumber(referenceTotal),
      unitVariance: nullableNumber(unitVariance),
      totalVariance: nullableNumber(totalVariance),
      variancePercent: nullableNumber(variancePercent),
      position: positionVsReference,
    },
  };
}
function mapAttachment(row: AttachmentRow): RfqComparisonAttachmentReference { return row; }
function mapEvaluation(row: EvaluationRow): RfqComparisonEvaluationRecord { return row; }

export async function findRunById(id: string): Promise<RfqComparisonRunRecord | null> {
  const result = await getPool().query<RunRow>(`SELECT ${RUN_SELECT} FROM rfq_comparison_runs WHERE id=$1`, [id]);
  return result.rows[0] ? mapRun(result.rows[0]) : null;
}

export async function findRunByIdForUpdate(client: PoolClient, id: string): Promise<RfqComparisonRunRecord | null> {
  const result = await client.query<RunRow>(`SELECT ${RUN_SELECT} FROM rfq_comparison_runs WHERE id=$1 FOR UPDATE`, [id]);
  return result.rows[0] ? mapRun(result.rows[0]) : null;
}

export async function findRunByIdempotencyForUpdate(client: PoolClient, rfqId: string, key: string): Promise<RfqComparisonRunRecord | null> {
  const result = await client.query<RunRow>(`SELECT ${RUN_SELECT} FROM rfq_comparison_runs WHERE rfq_id=$1 AND idempotency_key=$2 FOR UPDATE`, [rfqId, key]);
  return result.rows[0] ? mapRun(result.rows[0]) : null;
}

export async function createRunIdempotent(
  client: PoolClient,
  input: Omit<RfqComparisonRunRecord, 'id' | 'status' | 'snapshotAt' | 'createdAt'>,
): Promise<{ record: RfqComparisonRunRecord; created: boolean }> {
  const result = await client.query<RunRow>(
    `INSERT INTO rfq_comparison_runs
       (id, rfq_id, client_id, building_id, source_mode, currency,
        rfq_number_snapshot, created_by_user_id, idempotency_key,
        idempotency_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (rfq_id, idempotency_key) DO NOTHING
     RETURNING ${RUN_SELECT}`,
    [randomUUID(), input.rfqId, input.clientId, input.buildingId, input.sourceMode, input.currency,
      input.rfqNumberSnapshot, input.createdByUserId, input.idempotencyKey, input.idempotencyFingerprint],
  );
  if (result.rows[0]) return { record: mapRun(result.rows[0]), created: true };
  const existing = await findRunByIdempotencyForUpdate(client, input.rfqId, input.idempotencyKey);
  if (!existing) throw new Error('RFQ comparison idempotency conflict could not be resolved.');
  return { record: existing, created: false };
}

export async function listRunsByRfq(rfqId: string): Promise<RfqComparisonRunRecord[]> {
  const result = await getPool().query<RunRow>(`SELECT ${RUN_SELECT} FROM rfq_comparison_runs WHERE rfq_id=$1 ORDER BY snapshot_at DESC,id DESC`, [rfqId]);
  return result.rows.map(mapRun);
}

export async function createEvidenceWithClient(client: PoolClient, input: {
  comparisonRunId: string; rfqId: string; invitationId: string; quotationId: string;
  quotationRevisionId: string; vendorId: string; clientId: string; buildingId: string;
  quotationNumberSnapshot: string; revisionNumberSnapshot: number; submittedAt: Date;
  currency: string; validUntil: string | null; leadTimeDays: number | null;
  deliveryTerms: string | null; serviceTerms: string | null; notes: string | null;
  totalAmount: number;
}): Promise<RfqComparisonEvidenceRecord> {
  const result = await client.query<EvidenceRow>(
    `INSERT INTO rfq_comparison_evidence
       (id,comparison_run_id,rfq_id,invitation_id,quotation_id,quotation_revision_id,
        vendor_id,client_id,building_id,quotation_number_snapshot,revision_number_snapshot,
        submitted_at,currency,valid_until,lead_time_days,delivery_terms,service_terms,
        notes,total_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING ${EVIDENCE_SELECT}`,
    [randomUUID(), input.comparisonRunId, input.rfqId, input.invitationId, input.quotationId,
      input.quotationRevisionId, input.vendorId, input.clientId, input.buildingId,
      input.quotationNumberSnapshot, input.revisionNumberSnapshot, input.submittedAt,
      input.currency, input.validUntil, input.leadTimeDays, input.deliveryTerms,
      input.serviceTerms, input.notes, input.totalAmount],
  );
  return mapEvidence(result.rows[0]);
}

export async function createLineWithClient(client: PoolClient, input: {
  comparisonRunId: string; evidenceId: string; rfqId: string; rfqLineId: string;
  quotationLineId: string; sourceMode: 'MATERIAL' | 'SERVICE';
  rfqLineNumberSnapshot: number; descriptionSnapshot: string;
  offeredDescriptionSnapshot: string | null; requiredQuantitySnapshot: number | null;
  requiredUomId: string | null; quotedQuantitySnapshot: number | null; unitPrice: number;
  lineTotal: number; technicalCompliance: string; deviationNotes: string | null;
  lineStatus: 'QUOTED' | 'MISSING';
  reference: RfqComparisonLineRecord['reference'];
}): Promise<RfqComparisonLineRecord> {
  const result = await client.query<LineRow>(
    `INSERT INTO rfq_comparison_lines
       (id,comparison_run_id,evidence_id,rfq_id,rfq_line_id,quotation_line_id,source_mode,
        rfq_line_number_snapshot,description_snapshot,offered_description_snapshot,
        required_quantity_snapshot,required_uom_id,quoted_quantity_snapshot,unit_price,
        line_total,technical_compliance,deviation_notes,line_status,
        reference_price_entry_id,reference_unit_price,reference_currency,reference_uom_id,
        reference_scope_vendor,reference_scope_building,reference_effective_from,
        reference_resolution,reference_total,unit_variance,total_variance,
        variance_percent,position_vs_reference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
     RETURNING ${LINE_SELECT}`,
    [randomUUID(), input.comparisonRunId, input.evidenceId, input.rfqId, input.rfqLineId,
      input.quotationLineId, input.sourceMode, input.rfqLineNumberSnapshot,
      input.descriptionSnapshot, input.offeredDescriptionSnapshot, input.requiredQuantitySnapshot,
      input.requiredUomId, input.quotedQuantitySnapshot, input.unitPrice, input.lineTotal,
      input.technicalCompliance, input.deviationNotes, input.lineStatus,
      input.reference.priceEntryId, input.reference.unitPrice, input.reference.currency,
      input.reference.uomId, input.reference.scopeVendor, input.reference.scopeBuilding,
      input.reference.effectiveFrom, input.reference.resolution, input.reference.referenceTotal,
      input.reference.unitVariance, input.reference.totalVariance, input.reference.variancePercent,
      input.reference.position],
  );
  return mapLine(result.rows[0]);
}

export async function createAttachmentWithClient(client: PoolClient, input: {
  comparisonRunId: string; evidenceId: string; supportingDocumentId: string; documentId: string;
}): Promise<RfqComparisonAttachmentReference> {
  const result = await client.query<AttachmentRow>(
    `INSERT INTO rfq_comparison_evidence_attachments
       (id,comparison_run_id,evidence_id,supporting_document_id,document_id)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING ${ATTACHMENT_SELECT}`,
    [randomUUID(), input.comparisonRunId, input.evidenceId, input.supportingDocumentId, input.documentId],
  );
  return mapAttachment(result.rows[0]);
}

export async function listEvidence(comparisonRunId: string): Promise<RfqComparisonEvidenceRecord[]> {
  const result = await getPool().query<EvidenceRow>(`SELECT ${EVIDENCE_SELECT} FROM rfq_comparison_evidence WHERE comparison_run_id=$1 ORDER BY vendor_id,id`, [comparisonRunId]);
  return result.rows.map(mapEvidence);
}

export async function listLines(comparisonRunId: string): Promise<RfqComparisonLineRecord[]> {
  const result = await getPool().query<LineRow>(`SELECT ${LINE_SELECT} FROM rfq_comparison_lines WHERE comparison_run_id=$1 ORDER BY rfq_line_number_snapshot,evidence_id,id`, [comparisonRunId]);
  return result.rows.map(mapLine);
}

export async function listAttachments(comparisonRunId: string): Promise<RfqComparisonAttachmentReference[]> {
  const result = await getPool().query<AttachmentRow>(`SELECT ${ATTACHMENT_SELECT} FROM rfq_comparison_evidence_attachments WHERE comparison_run_id=$1 ORDER BY evidence_id,id`, [comparisonRunId]);
  return result.rows.map(mapAttachment);
}

export async function listEvaluations(comparisonRunId: string): Promise<RfqComparisonEvaluationRecord[]> {
  const result = await getPool().query<EvaluationRow>(`SELECT ${EVALUATION_SELECT} FROM rfq_comparison_evaluations WHERE comparison_run_id=$1 ORDER BY created_at,id`, [comparisonRunId]);
  return result.rows.map(mapEvaluation);
}

export async function findEvaluationById(id: string): Promise<RfqComparisonEvaluationRecord | null> {
  const result = await getPool().query<EvaluationRow>(`SELECT ${EVALUATION_SELECT} FROM rfq_comparison_evaluations WHERE id=$1`, [id]);
  return result.rows[0] ? mapEvaluation(result.rows[0]) : null;
}

export async function createEvaluationWithClient(client: PoolClient, input: {
  comparisonRunId: string; evidenceId: string; rfqId: string; vendorId: string;
  quotationRevisionId: string; createdByUserId: string;
} & Omit<CreateRfqEvaluationInput, 'comparisonRunId' | 'evidenceId' | 'vendorId'>): Promise<RfqComparisonEvaluationRecord> {
  const result = await client.query<EvaluationRow>(
    `INSERT INTO rfq_comparison_evaluations
       (id,comparison_run_id,evidence_id,rfq_id,vendor_id,quotation_revision_id,
        commercial_observation,technical_observation,compliance_observation,evaluator_note,
        created_by_user_id,updated_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
     RETURNING ${EVALUATION_SELECT}`,
    [randomUUID(), input.comparisonRunId, input.evidenceId, input.rfqId, input.vendorId,
      input.quotationRevisionId, input.commercialObservation ?? null, input.technicalObservation ?? null,
      input.complianceObservation ?? null, input.evaluatorNote ?? null, input.createdByUserId],
  );
  return mapEvaluation(result.rows[0]);
}

export async function updateEvaluationWithClient(client: PoolClient, id: string, input: UpdateRfqEvaluationInput, updatedByUserId: string): Promise<RfqComparisonEvaluationRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  const fields: [keyof UpdateRfqEvaluationInput, string][] = [
    ['commercialObservation', 'commercial_observation'],
    ['technicalObservation', 'technical_observation'],
    ['complianceObservation', 'compliance_observation'],
    ['evaluatorNote', 'evaluator_note'],
  ];
  for (const [key, column] of fields) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${column}=$${values.length}`);
    }
  }
  values.push(updatedByUserId);
  sets.push(`updated_by_user_id=$${values.length}`);
  values.push(id);
  const result = await client.query<EvaluationRow>(
    `UPDATE rfq_comparison_evaluations SET ${sets.join(',')},updated_at=NOW() WHERE id=$${values.length} RETURNING ${EVALUATION_SELECT}`,
    values,
  );
  return result.rows[0] ? mapEvaluation(result.rows[0]) : null;
}

export const rfqComparisonRepository = {
  createAttachmentWithClient,
  createEvaluationWithClient,
  createEvidenceWithClient,
  createLineWithClient,
  createRunIdempotent,
  findEvaluationById,
  findRunById,
  findRunByIdForUpdate,
  findRunByIdempotencyForUpdate,
  listAttachments,
  listEvidence,
  listEvaluations,
  listLines,
  listRunsByRfq,
  updateEvaluationWithClient,
};
