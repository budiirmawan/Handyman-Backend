import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { QUOTATION_WARRANTY_PROTOCOL, VARIATION_WARRANTY_PROTOCOL, type WarrantyTerms } from '../handyman-quotations/handyman-quotation-warranty-terms';
import type { QuotationDocumentSource } from '../handyman-quotations/handyman-quotation-document.service';

export type VariationWarrantyChange = { kind: 'ADD' | 'AMEND'; quotationLineId: string;
  replacesQuotationLineId: string | null; warrantyTerms: WarrantyTerms };
export type WarrantyPredecessor = { quotationLineId: string; description: string; warrantyTerms: WarrantyTerms;
  authority: 'QUOTATION' | 'VARIATION'; decisionId: string; documentId: string; sourceSha256: string; pdfSha256: string };
const conflict = (message: string) => new AppError({ code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION, statusCode: 409, message });

/** Only an exact ADD line and explicitly linked amendments have contractual
 * effect. Other lines in a revised quotation do not modify prior agreements. */
export function variationWarrantyChanges(revised: QuotationDocumentSource, kind: string, affectedLine: string): VariationWarrantyChange[] {
  if (revised.warrantyTermsProtocol !== QUOTATION_WARRANTY_PROTOCOL) throw conflict('Revised offer lacks explicit warranty terms.');
  const changes: VariationWarrantyChange[] = [];
  for (const line of revised.lines) {
    const added = kind === 'ADD' && line.id === affectedLine;
    if (!added && !line.replacesQuotationLineId) continue;
    if (!line.warrantyTerms || (added && line.replacesQuotationLineId)) {
      throw conflict('An ADD warranty line must be new; amendments require an exact predecessor.');
    }
    changes.push({ kind: added ? 'ADD' : 'AMEND', quotationLineId: line.id,
      replacesQuotationLineId: line.replacesQuotationLineId ?? null, warrantyTerms: line.warrantyTerms });
  }
  if (kind === 'ADD' && changes.filter(c => c.kind === 'ADD').length !== 1) throw conflict('ADD requires an exact warranty item.');
  return changes.sort((a,b) => a.quotationLineId < b.quotationLineId ? -1 : a.quotationLineId > b.quotationLineId ? 1 : 0);
}

/** Called under the scope lock at offer creation AND decision. Each predecessor
 * must itself be the exact, hash-pinned tenant-approved quotation or a previously
 * approved AND authorized variation change. A consented child makes that parent
 * stale, even before Operations authorizes it, preventing branching. */
export async function resolveWarrantyPredecessors(tx: PoolClient, scopeId: string, variationId: string,
  changes: VariationWarrantyChange[]): Promise<WarrantyPredecessor[]> {
  const out: WarrantyPredecessor[] = [];
  for (const change of changes) {
    const parent = change.replacesQuotationLineId;
    if (change.kind !== 'AMEND') continue;
    if (!parent) throw conflict('Warranty amendment requires an exact predecessor.');
    const stale = await tx.query(`SELECT 1 FROM handyman_warranty_term_supersessions
      WHERE execution_scope_id=$1 AND predecessor_line_id=$2 AND variation_id<>$3`, [scopeId,parent,variationId]);
    if (stale.rowCount) throw conflict('Warranty predecessor is already superseded by a consented variation; use its exact new line.');
    const base = await tx.query<{ decision_id: string; document_id: string; source_sha256: string; pdf_sha256: string; line: { description: string; warrantyTerms?: WarrantyTerms } }>(`
      SELECT q.id AS decision_id,d.id AS document_id,d.source_sha256,d.pdf_sha256,x AS line
      FROM handyman_execution_scopes s
      JOIN handyman_quotation_decisions q ON q.id=s.quotation_decision_id AND q.quotation_version_id=s.approved_quotation_version_id
        AND q.client_id=s.client_id AND q.tenant_company_id=s.tenant_company_id AND q.decision='APPROVE'
      JOIN handyman_quotation_documents d ON d.id=q.offer_document_id AND d.quotation_version_id=s.approved_quotation_version_id
        AND d.quotation_id=s.quotation_id AND d.client_id=s.client_id AND d.request_id=s.handyman_request_id
        AND d.source_sha256=q.offer_source_sha256 AND d.pdf_sha256=q.offer_pdf_sha256
      CROSS JOIN LATERAL jsonb_array_elements(d.source_snapshot->'lines') x
      WHERE s.id=$1 AND x->>'id'=$2 AND d.source_snapshot->>'warrantyTermsProtocol'=$3
        AND d.source_sha256=encode(sha256(convert_to(d.source_canonical,'UTF8')),'hex')
        AND d.source_canonical::jsonb=d.source_snapshot AND d.pdf_sha256=encode(sha256(d.pdf_bytes),'hex')`,
    [scopeId,parent,QUOTATION_WARRANTY_PROTOCOL]);
    const row = base.rows[0];
    if (row?.line.warrantyTerms) {
      out.push({ quotationLineId: parent, description: row.line.description, warrantyTerms: row.line.warrantyTerms,
        authority: 'QUOTATION', decisionId: row.decision_id, documentId: row.document_id,
        sourceSha256: row.source_sha256, pdfSha256: row.pdf_sha256 });
      continue;
    }
    const prior = await tx.query<{ decision_id: string; document_id: string; source_sha256: string; pdf_sha256: string; line: { description: string; warrantyTerms?: WarrantyTerms } }>(`
      SELECT e.id AS decision_id,d.id AS document_id,d.source_sha256,d.pdf_sha256,x AS line
      FROM handyman_scope_variations v JOIN handyman_variation_offer_documents d
        ON d.variation_id=v.id AND d.execution_scope_id=v.execution_scope_id AND d.client_id=v.client_id
      JOIN handyman_scope_variation_events r ON r.variation_id=v.id AND r.event_type='REVISED_QUOTATION'
        AND r.actor_role='OPERATIONS_MANAGER' AND r.metadata#>>'{offerDocument,id}'=d.id::text
        AND r.metadata#>>'{offerDocument,sourceSha256}'=d.source_sha256
        AND r.metadata#>>'{offerDocument,pdfSha256}'=d.pdf_sha256
      JOIN handyman_scope_variation_events e ON e.variation_id=v.id AND e.event_type='TENANT_DECISION'
        AND e.actor_role='TENANT' AND e.actor_user_id=v.tenant_decided_by_user_id
        AND e.metadata->>'decisionOutcome'='APPROVED' AND e.metadata#>>'{consentSnapshot,offerDocumentId}'=d.id::text
        AND e.metadata#>>'{consentSnapshot,offerDocumentVersion}'=d.variation_version::text
        AND e.metadata#>>'{consentSnapshot,offerPdfSha256}'=d.pdf_sha256
      CROSS JOIN LATERAL jsonb_array_elements(d.source_snapshot#>'{revised,lines}') x
      WHERE v.execution_scope_id=$1 AND v.id<>$2 AND v.tenant_decision_outcome='APPROVED'
        AND v.status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY')
        AND d.source_snapshot->>'warrantyTermsProtocol'=$4 AND x->>'id'=$3
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.source_snapshot->'warrantyChanges') c WHERE c->>'quotationLineId'=$3)
        AND d.source_sha256=encode(sha256(convert_to(d.source_canonical,'UTF8')),'hex')
        AND d.source_canonical::jsonb=d.source_snapshot AND d.pdf_sha256=encode(sha256(d.pdf_bytes),'hex')`,
    [scopeId,variationId,parent,VARIATION_WARRANTY_PROTOCOL]);
    if (prior.rows.length !== 1 || !prior.rows[0]?.line.warrantyTerms) {
      throw conflict('Warranty predecessor has no exact tenant-approved and authorized agreement; historical ambiguity requires a supplemental agreement.');
    }
    const p = prior.rows[0];
    out.push({ quotationLineId: parent, description: p.line.description, warrantyTerms: p.line.warrantyTerms!, authority: 'VARIATION',
      decisionId: p.decision_id, documentId: p.document_id, sourceSha256: p.source_sha256, pdfSha256: p.pdf_sha256 });
  }
  return out;
}
