import type { PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import { handymanBastRepository } from '../handyman-bast/handyman-bast.repository';
import { verifiedHandymanBastCustomerConsent } from '../handyman-bast/handyman-bast-customer-consent';
import { verifyStoredOfficialBast, type OfficialBastStored } from '../handyman-bast/handyman-bast-document.service';

export type ScopeCompletion = {
  status: 'VERIFIED' | 'NOT_VERIFIED' | 'STALE_OR_UNVERIFIED';
  workState: 'COMPLETED' | 'INCOMPLETE' | 'UNKNOWN';
  manifestId: string | null;
  manifestVersion: number | null;
  manifestSha256: string | null;
  verificationId: string | null;
  qcRunId: string | null;
  qcRunVersion: number | null;
};

type ScopeIdentity = {
  id: string; client_id: string; building_id: string; handyman_request_id: string;
  tenant_company_id: string; tenant_pic_id: string | null; space_id: string | null;
  quotation_id: string; approved_quotation_version_id: string; quotation_decision_id: string;
};

type BastStatus = 'VERIFIED' | 'MISSING' | 'NOT_ACCEPTED' | 'UNVERIFIED' | 'STALE' | 'AMBIGUOUS';
export type ScopeBastAcceptance = {
  status: BastStatus;
  blockerCode: string | null;
  blockerMessage: string | null;
  bastId: string | null;
  officialDocumentId: string | null;
  officialPdfSha256: string | null;
  acceptanceEventId: string | null;
  signOffId: string | null;
  acceptedAt: string | null;
};

const empty = (): Omit<ScopeBastAcceptance, 'status' | 'blockerCode' | 'blockerMessage'> => ({
  bastId: null, officialDocumentId: null, officialPdfSha256: null,
  acceptanceEventId: null, signOffId: null, acceptedAt: null,
});
function blocked(status: Exclude<BastStatus, 'VERIFIED'>, code: string, message: string,
  facts: Partial<ScopeBastAcceptance> = {}): ScopeBastAcceptance {
  return { ...empty(), ...facts, status, blockerCode: code, blockerMessage: message };
}

/**
 * The active BAST and its qualified customer receipt must identify this exact
 * original scope. The immutable official ISSUE additionally binds the accepted
 * BAST to the same quotation approval, completion review, manifest and QC PASS.
 * Old BASTs are preserved but cannot be backfilled or guessed into readiness.
 * Caller holds the scope lock used by the existing BAST/QC/manifest writers.
 */
export async function readScopeBastAcceptance(
  tx: PoolClient, scope: ScopeIdentity, completion: ScopeCompletion,
): Promise<ScopeBastAcceptance> {
  const active = (await tx.query<{id: string; client_id: string; status: string}>(`SELECT id,client_id,status
    FROM handyman_bast_documents WHERE execution_scope_id=$1 AND status NOT IN ('VOID','REJECTED')
    ORDER BY id FOR SHARE`, [scope.id])).rows;
  if (active.length > 1) return blocked('AMBIGUOUS', 'BAST_AMBIGUOUS', 'More than one active BAST is associated with this scope.');
  if (!active.length) {
    const rejected = (await tx.query(`SELECT 1 FROM handyman_bast_documents
      WHERE execution_scope_id=$1 AND status='REJECTED' LIMIT 1`, [scope.id])).rowCount;
    return blocked('MISSING', rejected ? 'BAST_REJECTED' : 'BAST_NOT_ISSUED',
      rejected ? 'The customer rejected the BAST and no replacement is accepted.' : 'No issued and accepted BAST is available for this scope.');
  }
  const row = active[0];
  const facts = { bastId: row.id };
  if (row.client_id !== scope.client_id) return blocked('UNVERIFIED', 'BAST_SCOPE_BINDING_INVALID',
    'The BAST Client does not match its execution scope.', facts);
  if (row.status !== 'ACCEPTED') return blocked('NOT_ACCEPTED', row.status === 'DRAFT' ? 'BAST_NOT_ISSUED' : 'BAST_NOT_ACCEPTED',
    row.status === 'DRAFT' ? 'The BAST is not issued.' : 'The customer has not accepted the issued BAST.', facts);

  const bast = await handymanBastRepository.findBastById(tx, row.id);
  if (!bast || !bast.acceptedAt || !bast.issuedAt || bast.executionScopeId !== scope.id || bast.clientId !== scope.client_id) {
    return blocked('UNVERIFIED', 'BAST_ACCEPTANCE_BINDING_UNVERIFIED', 'Accepted BAST identity or timestamps are unavailable.', facts);
  }
  const events = await handymanBastRepository.listEventsByBastId(tx, row.id);
  const signOffs = await handymanBastRepository.listSignOffsByBastId(tx, row.id);
  const decisions = events.filter(event => event.eventType === 'ACCEPT' || event.eventType === 'REJECT');
  const accepted = decisions.filter(event => event.eventType === 'ACCEPT');
  const issued = events.filter(event => event.eventType === 'ISSUE');
  const signOff = accepted.length === 1 ? signOffs.filter(s => s.eventId === accepted[0].id && s.decision === 'ACCEPT') : [];
  if (decisions.length !== 1 || accepted.length !== 1 || issued.length !== 1 || signOffs.length !== 1 || signOff.length !== 1 ||
      issued[0].bastId !== bast.id || issued[0].clientId !== scope.client_id || issued[0].executionScopeId !== scope.id) {
    return blocked('UNVERIFIED', 'BAST_ACCEPTANCE_BINDING_UNVERIFIED', 'The unique ISSUE and independently accepted sign-off are not proven.', facts);
  }
  const consent = verifiedHandymanBastCustomerConsent(bast, accepted[0], signOff[0]);
  if (!consent || consent.handymanRequestId !== scope.handyman_request_id || consent.buildingId !== scope.building_id ||
      consent.tenantCompanyId !== scope.tenant_company_id || consent.tenantPicId !== scope.tenant_pic_id ||
      consent.approvedQuotationVersionId !== scope.approved_quotation_version_id ||
      ('spaceId' in consent && consent.spaceId !== scope.space_id) || consent.issueEventId !== issued[0].id) {
    return blocked('UNVERIFIED', 'BAST_ACCEPTANCE_BINDING_UNVERIFIED',
      'The independently verified customer decision does not prove this exact Request, approval and scope.', facts);
  }
  const docs = (await tx.query<OfficialBastStored>('SELECT * FROM handyman_bast_official_documents WHERE bast_id=$1', [row.id])).rows;
  if (docs.length !== 1) return blocked('UNVERIFIED', 'BAST_OFFICIAL_BINDING_MISSING',
    'The exact issued BAST and reviewed completion are not bound by an official record.', facts);
  const doc = docs[0];
  try { verifyStoredOfficialBast(doc); }
  catch (error) {
    if (!(error instanceof AppError)) throw error;
    return blocked('UNVERIFIED', 'BAST_OFFICIAL_INTEGRITY_INVALID', 'The issued BAST record failed integrity verification.', facts);
  }
  if (doc.bast_id !== bast.id || doc.issue_event_id !== issued[0].id || doc.client_id !== scope.client_id ||
      doc.execution_scope_id !== scope.id || doc.request_id !== scope.handyman_request_id ||
      doc.building_id !== scope.building_id || doc.tenant_company_id !== scope.tenant_company_id ||
      doc.source_snapshot.customer.spaceId !== scope.space_id ||
      doc.source_snapshot.approvedQuotation?.id !== scope.quotation_id ||
      doc.source_snapshot.approvedQuotation?.versionId !== scope.approved_quotation_version_id ||
      doc.source_snapshot.approvedQuotation?.decisionId !== scope.quotation_decision_id ||
      doc.qc_run_id !== bast.qcRunId || doc.qc_run_id !== consent.qcRunId ||
      doc.issued_at.getTime() !== bast.issuedAt.getTime() || issued[0].occurredAt.getTime() !== bast.issuedAt.getTime()) {
    return blocked('UNVERIFIED', 'BAST_SCOPE_BINDING_INVALID',
      'The accepted BAST does not match the exact issued artifact and approved scope.', facts);
  }
  const verifiedFacts = { ...facts, officialDocumentId: doc.id, officialPdfSha256: doc.pdf_sha256,
    acceptanceEventId: accepted[0].id, signOffId: signOff[0].id, acceptedAt: bast.acceptedAt.toISOString() };
  if (completion.status !== 'VERIFIED' || doc.completion_verification_id !== completion.verificationId ||
      doc.manifest_id !== completion.manifestId || doc.manifest_version !== completion.manifestVersion ||
      doc.manifest_sha256 !== completion.manifestSha256 || doc.qc_run_id !== completion.qcRunId ||
      doc.qc_run_version !== completion.qcRunVersion) {
    return blocked('STALE', 'BAST_COMPLETION_BINDING_STALE',
      'The historical acceptance does not bind the current verified completion and QC PASS.', verifiedFacts);
  }
  return { ...verifiedFacts, status: 'VERIFIED', blockerCode: null, blockerMessage: null };
}
