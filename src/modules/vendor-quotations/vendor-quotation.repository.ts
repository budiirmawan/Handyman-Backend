import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  UpdateVendorQuotationLineInput,
  UpdateVendorQuotationRevisionInput,
  VendorQuotationFilters,
  VendorQuotationLineRecord,
  VendorQuotationRecord,
  VendorQuotationRevisionRecord,
} from './vendor-quotation.types';

type QuotationRow = VendorQuotationRecord;
type RevisionRow = VendorQuotationRevisionRecord;
type LineRow = {
  id: string;
  quotationRevisionId: string;
  quotationId: string;
  rfqId: string;
  rfqLineId: string;
  sourceMode: 'MATERIAL' | 'SERVICE';
  lineNumberSnapshot: number;
  description: string | null;
  requiredQuantitySnapshot: string | number | null;
  requiredUomId: string | null;
  sourceServiceId: string | null;
  quotedQuantity: string | number | null;
  unitPrice: string | number;
  lineTotal: string | number;
  technicalCompliance: VendorQuotationLineRecord['technicalCompliance'];
  deviationNotes: string | null;
  createdBySessionId: string;
  createdAt: Date;
  updatedAt: Date;
};

const QUOTATION_SELECT = `
  id, rfq_id AS "rfqId", invitation_id AS "invitationId",
  vendor_id AS "vendorId", client_id AS "clientId",
  building_id AS "buildingId", quotation_number AS "quotationNumber",
  status, created_by_session_id AS "createdBySessionId",
  idempotency_key AS "idempotencyKey",
  idempotency_fingerprint AS "idempotencyFingerprint",
  created_at AS "createdAt", updated_at AS "updatedAt"
`.trim();

const REVISION_SELECT = `
  id, quotation_id AS "quotationId", rfq_id AS "rfqId",
  invitation_id AS "invitationId", vendor_id AS "vendorId",
  client_id AS "clientId", building_id AS "buildingId",
  revision_number AS "revisionNumber", status, currency,
  valid_until::text AS "validUntil", lead_time_days AS "leadTimeDays",
  delivery_terms AS "deliveryTerms", service_terms AS "serviceTerms",
  notes, created_by_session_id AS "createdBySessionId",
  submitted_at AS "submittedAt",
  submitted_by_session_id AS "submittedBySessionId",
  superseded_at AS "supersededAt",
  idempotency_key AS "idempotencyKey",
  idempotency_fingerprint AS "idempotencyFingerprint",
  created_at AS "createdAt", updated_at AS "updatedAt"
`.trim();

const LINE_SELECT = `
  id, quotation_revision_id AS "quotationRevisionId",
  quotation_id AS "quotationId", rfq_id AS "rfqId",
  rfq_line_id AS "rfqLineId", source_mode AS "sourceMode",
  line_number_snapshot AS "lineNumberSnapshot", description,
  required_quantity_snapshot AS "requiredQuantitySnapshot",
  required_uom_id AS "requiredUomId",
  source_service_id AS "sourceServiceId",
  quoted_quantity AS "quotedQuantity",
  unit_price AS "unitPrice", line_total AS "lineTotal",
  technical_compliance AS "technicalCompliance",
  deviation_notes AS "deviationNotes",
  created_by_session_id AS "createdBySessionId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`.trim();

function mapQuotation(row: QuotationRow): VendorQuotationRecord { return row; }
function mapRevision(row: RevisionRow): VendorQuotationRevisionRecord { return row; }
function mapLine(row: LineRow): VendorQuotationLineRecord {
  return {
    ...row,
    requiredQuantitySnapshot: row.requiredQuantitySnapshot === null ? null : Number(row.requiredQuantitySnapshot),
    quotedQuantity: row.quotedQuantity === null ? null : Number(row.quotedQuantity),
    unitPrice: Number(row.unitPrice),
    lineTotal: Number(row.lineTotal),
  };
}

export async function findQuotationById(id: string): Promise<VendorQuotationRecord | null> {
  const result = await getPool().query<QuotationRow>(`SELECT ${QUOTATION_SELECT} FROM vendor_quotations WHERE id = $1`, [id]);
  return result.rows[0] ? mapQuotation(result.rows[0]) : null;
}
export async function findQuotationByIdForUpdate(client: PoolClient, id: string): Promise<VendorQuotationRecord | null> {
  const result = await client.query<QuotationRow>(`SELECT ${QUOTATION_SELECT} FROM vendor_quotations WHERE id = $1 FOR UPDATE`, [id]);
  return result.rows[0] ? mapQuotation(result.rows[0]) : null;
}
export async function findQuotationByInvitation(invitationId: string): Promise<VendorQuotationRecord | null> {
  const result = await getPool().query<QuotationRow>(`SELECT ${QUOTATION_SELECT} FROM vendor_quotations WHERE invitation_id = $1`, [invitationId]);
  return result.rows[0] ? mapQuotation(result.rows[0]) : null;
}
export async function findQuotationByInvitationForUpdate(client: PoolClient, invitationId: string): Promise<VendorQuotationRecord | null> {
  const result = await client.query<QuotationRow>(`SELECT ${QUOTATION_SELECT} FROM vendor_quotations WHERE invitation_id = $1 FOR UPDATE`, [invitationId]);
  return result.rows[0] ? mapQuotation(result.rows[0]) : null;
}
export async function findQuotationByIdempotencyForUpdate(client: PoolClient, invitationId: string, key: string): Promise<VendorQuotationRecord | null> {
  const result = await client.query<QuotationRow>(`SELECT ${QUOTATION_SELECT} FROM vendor_quotations WHERE invitation_id = $1 AND idempotency_key = $2 FOR UPDATE`, [invitationId, key]);
  return result.rows[0] ? mapQuotation(result.rows[0]) : null;
}
export async function createQuotationIdempotent(client: PoolClient, input: {
  rfqId: string; invitationId: string; vendorId: string; clientId: string; buildingId: string;
  quotationNumber: string; createdBySessionId: string; idempotencyKey: string; idempotencyFingerprint: string;
}): Promise<{ record: VendorQuotationRecord; created: boolean }> {
  const result = await client.query<QuotationRow>(
    `INSERT INTO vendor_quotations
       (id, rfq_id, invitation_id, vendor_id, client_id, building_id,
        quotation_number, created_by_session_id, idempotency_key, idempotency_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (invitation_id, idempotency_key) DO NOTHING
     RETURNING ${QUOTATION_SELECT}`,
    [randomUUID(), input.rfqId, input.invitationId, input.vendorId, input.clientId, input.buildingId,
      input.quotationNumber, input.createdBySessionId, input.idempotencyKey, input.idempotencyFingerprint],
  );
  if (result.rows[0]) return { record: mapQuotation(result.rows[0]), created: true };
  const existing = await findQuotationByIdempotencyForUpdate(client, input.invitationId, input.idempotencyKey);
  if (!existing) throw new Error('Vendor quotation idempotency conflict could not be resolved.');
  return { record: existing, created: false };
}
export async function updateQuotationStatusWithClient(client: PoolClient, id: string, status: VendorQuotationRecord['status']): Promise<VendorQuotationRecord | null> {
  const result = await client.query<QuotationRow>(`UPDATE vendor_quotations SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING ${QUOTATION_SELECT}`, [id, status]);
  return result.rows[0] ? mapQuotation(result.rows[0]) : null;
}

export async function findRevisionById(id: string): Promise<VendorQuotationRevisionRecord | null> {
  const result = await getPool().query<RevisionRow>(`SELECT ${REVISION_SELECT} FROM vendor_quotation_revisions WHERE id=$1`, [id]);
  return result.rows[0] ? mapRevision(result.rows[0]) : null;
}
export async function findRevisionByIdForUpdate(client: PoolClient, id: string): Promise<VendorQuotationRevisionRecord | null> {
  const result = await client.query<RevisionRow>(`SELECT ${REVISION_SELECT} FROM vendor_quotation_revisions WHERE id=$1 FOR UPDATE`, [id]);
  return result.rows[0] ? mapRevision(result.rows[0]) : null;
}
export async function findDraftRevisionForUpdate(client: PoolClient, quotationId: string): Promise<VendorQuotationRevisionRecord | null> {
  const result = await client.query<RevisionRow>(`SELECT ${REVISION_SELECT} FROM vendor_quotation_revisions WHERE quotation_id=$1 AND status='DRAFT' FOR UPDATE`, [quotationId]);
  return result.rows[0] ? mapRevision(result.rows[0]) : null;
}
export async function findRevisionByIdempotencyForUpdate(client: PoolClient, quotationId: string, key: string): Promise<VendorQuotationRevisionRecord | null> {
  const result = await client.query<RevisionRow>(`SELECT ${REVISION_SELECT} FROM vendor_quotation_revisions WHERE quotation_id=$1 AND idempotency_key=$2 FOR UPDATE`, [quotationId, key]);
  return result.rows[0] ? mapRevision(result.rows[0]) : null;
}
export async function nextRevisionNumber(client: PoolClient, quotationId: string): Promise<number> {
  const result = await client.query<{ nextRevision: number }>(`SELECT COALESCE(MAX(revision_number),0)+1 AS "nextRevision" FROM vendor_quotation_revisions WHERE quotation_id=$1`, [quotationId]);
  return Number(result.rows[0]?.nextRevision ?? 1);
}
export async function createRevisionWithClient(client: PoolClient, input: {
  quotationId: string; rfqId: string; invitationId: string; vendorId: string; clientId: string; buildingId: string;
  revisionNumber: number; currency: string; validUntil: string | null; leadTimeDays: number | null;
  deliveryTerms: string | null; serviceTerms: string | null; notes: string | null; createdBySessionId: string;
  idempotencyKey: string; idempotencyFingerprint: string;
}): Promise<VendorQuotationRevisionRecord> {
  const result = await client.query<RevisionRow>(
    `INSERT INTO vendor_quotation_revisions
       (id,quotation_id,rfq_id,invitation_id,vendor_id,client_id,building_id,
        revision_number,currency,valid_until,lead_time_days,delivery_terms,service_terms,
        notes,created_by_session_id,idempotency_key,idempotency_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING ${REVISION_SELECT}`,
    [randomUUID(), input.quotationId, input.rfqId, input.invitationId, input.vendorId, input.clientId, input.buildingId,
      input.revisionNumber, input.currency, input.validUntil, input.leadTimeDays, input.deliveryTerms, input.serviceTerms,
      input.notes, input.createdBySessionId, input.idempotencyKey, input.idempotencyFingerprint],
  );
  return mapRevision(result.rows[0]);
}
export async function updateRevisionWithClient(client: PoolClient, id: string, input: UpdateVendorQuotationRevisionInput): Promise<VendorQuotationRevisionRecord | null> {
  const values: unknown[] = []; const sets: string[] = [];
  const fields: [keyof UpdateVendorQuotationRevisionInput, string][] = [
    ['currency','currency'],['validUntil','valid_until'],['leadTimeDays','lead_time_days'],
    ['deliveryTerms','delivery_terms'],['serviceTerms','service_terms'],['notes','notes'],
  ];
  for (const [key,column] of fields) if (input[key] !== undefined) { values.push(input[key]); sets.push(`${column}=$${values.length}`); }
  if (!sets.length) return findRevisionByIdForUpdate(client,id);
  values.push(id); sets.push('updated_at=NOW()');
  const result = await client.query<RevisionRow>(`UPDATE vendor_quotation_revisions SET ${sets.join(',')} WHERE id=$${values.length} AND status='DRAFT' RETURNING ${REVISION_SELECT}`, values);
  return result.rows[0] ? mapRevision(result.rows[0]) : null;
}
export async function submitRevisionWithClient(client: PoolClient, revisionId: string, quotationId: string, sessionId: string): Promise<VendorQuotationRevisionRecord | null> {
  await client.query(`UPDATE vendor_quotation_revisions SET status='SUPERSEDED',superseded_at=NOW(),updated_at=NOW() WHERE quotation_id=$1 AND status='SUBMITTED'`, [quotationId]);
  const result = await client.query<RevisionRow>(`UPDATE vendor_quotation_revisions SET status='SUBMITTED',submitted_at=NOW(),submitted_by_session_id=$2,updated_at=NOW() WHERE id=$1 AND quotation_id=$3 AND status='DRAFT' RETURNING ${REVISION_SELECT}`, [revisionId,sessionId,quotationId]);
  return result.rows[0] ? mapRevision(result.rows[0]) : null;
}
export async function listRevisions(quotationId: string): Promise<VendorQuotationRevisionRecord[]> {
  const result = await getPool().query<RevisionRow>(`SELECT ${REVISION_SELECT} FROM vendor_quotation_revisions WHERE quotation_id=$1 ORDER BY revision_number DESC`, [quotationId]);
  return result.rows.map(mapRevision);
}
export async function listQuotationsByRfq(rfqId: string, filters: VendorQuotationFilters): Promise<VendorQuotationRecord[]> {
  const values: unknown[] = [rfqId]; const conditions = ['rfq_id=$1'];
  if (filters.vendorId !== undefined) { values.push(filters.vendorId); conditions.push(`vendor_id=$${values.length}`); }
  if (filters.status !== undefined) { values.push(filters.status); conditions.push(`status=$${values.length}`); }
  const result = await getPool().query<QuotationRow>(`SELECT ${QUOTATION_SELECT} FROM vendor_quotations WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,id DESC`, values);
  return result.rows.map(mapQuotation);
}

export async function createLineWithClient(client: PoolClient, input: {
  quotationRevisionId: string; quotationId: string; rfqId: string; rfqLineId: string; sourceMode: 'MATERIAL'|'SERVICE';
  lineNumberSnapshot: number; description: string|null; requiredQuantitySnapshot: number|null; requiredUomId: string|null;
  sourceServiceId: string|null; quotedQuantity: number|null; unitPrice: number; technicalCompliance: VendorQuotationLineRecord['technicalCompliance'];
  deviationNotes: string|null; createdBySessionId: string;
}): Promise<VendorQuotationLineRecord> {
  const result = await client.query<LineRow>(
    `INSERT INTO vendor_quotation_lines
       (id,quotation_revision_id,quotation_id,rfq_id,rfq_line_id,source_mode,line_number_snapshot,
        description,required_quantity_snapshot,required_uom_id,source_service_id,quoted_quantity,unit_price,
        technical_compliance,deviation_notes,created_by_session_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING ${LINE_SELECT}`,
    [randomUUID(),input.quotationRevisionId,input.quotationId,input.rfqId,input.rfqLineId,input.sourceMode,input.lineNumberSnapshot,
      input.description,input.requiredQuantitySnapshot,input.requiredUomId,input.sourceServiceId,input.quotedQuantity,input.unitPrice,input.technicalCompliance,input.deviationNotes,input.createdBySessionId],
  );
  return mapLine(result.rows[0]);
}
export async function findLineById(id: string): Promise<VendorQuotationLineRecord | null> {
  const result = await getPool().query<LineRow>(`SELECT ${LINE_SELECT} FROM vendor_quotation_lines WHERE id=$1`, [id]);
  return result.rows[0] ? mapLine(result.rows[0]) : null;
}
export async function findLineByIdForUpdate(client: PoolClient, id: string): Promise<VendorQuotationLineRecord | null> {
  const result = await client.query<LineRow>(`SELECT ${LINE_SELECT} FROM vendor_quotation_lines WHERE id=$1 FOR UPDATE`, [id]);
  return result.rows[0] ? mapLine(result.rows[0]) : null;
}
export async function listLines(quotationRevisionId: string): Promise<VendorQuotationLineRecord[]> {
  const result = await getPool().query<LineRow>(`SELECT ${LINE_SELECT} FROM vendor_quotation_lines WHERE quotation_revision_id=$1 ORDER BY line_number_snapshot,id`, [quotationRevisionId]);
  return result.rows.map(mapLine);
}
export async function listLinesWithClient(client: PoolClient, quotationRevisionId: string): Promise<VendorQuotationLineRecord[]> {
  const result = await client.query<LineRow>(`SELECT ${LINE_SELECT} FROM vendor_quotation_lines WHERE quotation_revision_id=$1 ORDER BY line_number_snapshot,id`, [quotationRevisionId]);
  return result.rows.map(mapLine);
}
export async function updateLineWithClient(client: PoolClient, id: string, input: UpdateVendorQuotationLineInput): Promise<VendorQuotationLineRecord | null> {
  const values: unknown[] = []; const sets: string[] = [];
  const fields: [keyof UpdateVendorQuotationLineInput,string][] = [['quotedQuantity','quoted_quantity'],['unitPrice','unit_price'],['description','description'],['technicalCompliance','technical_compliance'],['deviationNotes','deviation_notes']];
  for (const [key,column] of fields) if (input[key] !== undefined) { values.push(input[key]); sets.push(`${column}=$${values.length}`); }
  if (!sets.length) return findLineByIdForUpdate(client,id);
  values.push(id); sets.push('updated_at=NOW()');
  const result = await client.query<LineRow>(`UPDATE vendor_quotation_lines SET ${sets.join(',')} WHERE id=$${values.length} AND quotation_revision_id IN (SELECT id FROM vendor_quotation_revisions WHERE status='DRAFT') RETURNING ${LINE_SELECT}`, values);
  return result.rows[0] ? mapLine(result.rows[0]) : null;
}
export async function totalForRevision(revisionId: string): Promise<number> {
  const result = await getPool().query<{ total: string }>(`SELECT COALESCE(SUM(line_total),0)::text AS total FROM vendor_quotation_lines WHERE quotation_revision_id=$1`, [revisionId]);
  return Number(result.rows[0]?.total ?? 0);
}
export async function totalForRevisionWithClient(client: PoolClient, revisionId: string): Promise<number> {
  const result = await client.query<{ total: string }>(`SELECT COALESCE(SUM(line_total),0)::text AS total FROM vendor_quotation_lines WHERE quotation_revision_id=$1`, [revisionId]);
  return Number(result.rows[0]?.total ?? 0);
}

export const vendorQuotationRepository = {
  createLineWithClient, createQuotationIdempotent, createRevisionWithClient,
  findDraftRevisionForUpdate, findLineById, findLineByIdForUpdate,
  findQuotationById, findQuotationByIdForUpdate, findQuotationByIdempotencyForUpdate,
  findQuotationByInvitation, findQuotationByInvitationForUpdate,
  findRevisionById, findRevisionByIdForUpdate, findRevisionByIdempotencyForUpdate,
  listLines, listLinesWithClient, listQuotationsByRfq, listRevisions, nextRevisionNumber,
  submitRevisionWithClient, totalForRevision, totalForRevisionWithClient,
  updateLineWithClient, updateQuotationStatusWithClient, updateRevisionWithClient,
};
