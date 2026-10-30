import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { canAccessBuildingScopedResource } from '../context-access';
import { createEvidenceStorage, isManagedStorageKey } from '../evidence/storage';
import { handymanEvidenceQcRepository } from '../handyman-evidence-qc';
import { permissionRepository } from '../permissions';
import { requireCurrentWarrantyCertificateForClaim } from '../handyman-warranty-certificates/handyman-warranty-certificate.service';
import { handymanServiceWarrantyClaimRepository } from './handyman-service-warranty-claim.repository';
import type { HandymanServiceWarrantyClaimRecord } from './handyman-service-warranty-claim.types';
import { handymanServiceWarrantyClaimNotFoundError } from './handyman-service-warranty-claim.errors';

export const HANDYMAN_WARRANTY_ASSESS_PERMISSION = 'handyman.warranty.assess';
type Executor = Pick<PoolClient, 'query'>;
type CoverageKind = 'LABOR' | 'PARTS';
type AssessmentResult = 'COVERED' | 'REJECTED' | 'NEEDS_EVIDENCE';
type Condition = 'SATISFIED' | 'NOT_SATISFIED' | 'UNDETERMINED';
type Exclusion = 'NOT_APPLICABLE' | 'APPLIES' | 'UNDETERMINED';
export type ClaimCertificatePin = {
  certificateId: string;
  certificateSourceSha256: string;
  certificatePdfSha256: string;
  certificateManifestVersion: number;
  itemLineId: string;
  coverageKind: CoverageKind;
};
type BindingRow = {
  claim_id: string; certificate_id: string; certificate_number: string;
  certificate_source_sha256: string; certificate_pdf_sha256: string; certificate_manifest_version: number;
  item_line_id: string; coverage_kind: CoverageKind; item_snapshot: Record<string, unknown>;
  starts_at_text: string; ends_at_text: string; created_by_user_id: string; created_at: Date;
};
type EvidenceSnapshot = {
  recordId: string; finalizeEventId: string | null; byteVerified: boolean;
  files: Array<{ id: string; mediaKind: string; contentType: string; byteSize: number; sha256Digest: string }>;
};
type AssessmentRow = {
  id: string; claim_id: string; revision: number; result: AssessmentResult; reason: string;
  conditions_disposition: Condition; conditions_reason: string; exclusions_disposition: Exclusion;
  exclusions_reason: string; claim_submitted_at_text: string; claim_evidence: EvidenceSnapshot;
  review_evidence: EvidenceSnapshot; reviewer_user_id: string; idempotency_key: string;
  command_sha256: string; assessed_at: Date;
};
export type RecordWarrantyClaimAssessmentInput = ClaimCertificatePin & {
  claimId: string; expectedRevision: number; result: AssessmentResult; reason: string;
  conditionsDisposition: Condition; conditionsReason: string;
  exclusionsDisposition: Exclusion; exclusionsReason: string;
  evidenceRecordId: string; idempotencyKey: string;
};
const conflict = (message: string) => new AppError({ code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_NOT_ELIGIBLE, statusCode: 409, message });
const forbidden = () => new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403,
  message: 'An independent, explicitly granted warranty assessor with exact-Building access is required.' });
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) throw AppError.validation(`A valid ${name} is required.`);
  return value.trim().toLowerCase();
}
function text(value: unknown, name: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value))
    throw AppError.validation(`${name} must be explicit non-empty text of at most ${max} characters.`);
  return value.trim();
}
function hash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw AppError.validation(`A valid ${name} is required.`);
  return value;
}
export function parseClaimCertificatePin(input: Record<string, unknown>): ClaimCertificatePin {
  if (!Number.isInteger(input.certificateManifestVersion) || (input.certificateManifestVersion as number) < 1)
    throw AppError.validation('certificateManifestVersion must be a positive integer.');
  if (input.coverageKind !== 'LABOR' && input.coverageKind !== 'PARTS') throw AppError.validation('coverageKind must be LABOR or PARTS.');
  return { certificateId: uuid(input.certificateId, 'certificateId'),
    certificateSourceSha256: hash(input.certificateSourceSha256, 'certificateSourceSha256'),
    certificatePdfSha256: hash(input.certificatePdfSha256, 'certificatePdfSha256'),
    certificateManifestVersion: input.certificateManifestVersion as number,
    itemLineId: uuid(input.itemLineId, 'itemLineId'), coverageKind: input.coverageKind };
}
const bindingSelect = `SELECT b.*,to_char(b.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at_text,
  to_char(b.ends_at_exclusive AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at_text
  FROM handyman_warranty_claim_bindings b WHERE b.claim_id=$1`;
const assessmentSelect = `SELECT a.*,to_char(a.claim_submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS claim_submitted_at_text
  FROM handyman_warranty_claim_assessments a`;
function pinFromBinding(b: BindingRow): ClaimCertificatePin {
  return { certificateId:b.certificate_id, certificateSourceSha256:b.certificate_source_sha256,
    certificatePdfSha256:b.certificate_pdf_sha256, certificateManifestVersion:b.certificate_manifest_version,
    itemLineId:b.item_line_id, coverageKind:b.coverage_kind };
}
async function binding(tx: Executor, claimId: string): Promise<BindingRow> {
  const row = (await tx.query<BindingRow>(bindingSelect, [claimId])).rows[0];
  if (!row) throw conflict('The claim has no authoritative certificate and item binding. Historical claims are not backfilled.');
  return row;
}
function samePin(actual: ClaimCertificatePin, expected: ClaimCertificatePin): void {
  const pin = { certificateId:expected.certificateId, certificateSourceSha256:expected.certificateSourceSha256,
    certificatePdfSha256:expected.certificatePdfSha256, certificateManifestVersion:expected.certificateManifestVersion,
    itemLineId:expected.itemLineId, coverageKind:expected.coverageKind };
  if (stableJson(actual) !== stableJson(pin)) throw conflict('The certificate, item, coverage or document version is stale or mismatched.');
}

/** Called with the original scope locked, before the OPEN transaction commits. */
export async function bindClaimToCertificate(tx: PoolClient, claim: HandymanServiceWarrantyClaimRecord,
  actor: string, pin: ClaimCertificatePin): Promise<void> {
  const doc = await requireCurrentWarrantyCertificateForClaim(tx, pin.certificateId, claim);
  if (doc.sourceSha256 !== pin.certificateSourceSha256 || doc.pdfSha256 !== pin.certificatePdfSha256 ||
      doc.manifestVersion !== pin.certificateManifestVersion) throw conflict('The issued certificate version is stale or mismatched.');
  const item = doc.items.find(x => x.rootLineId === pin.itemLineId);
  if (!item || (item.terms.coverage !== pin.coverageKind && item.terms.coverage !== 'BOTH'))
    throw conflict('The certificate does not cover this exact completed item and coverage kind.');
  await tx.query(`INSERT INTO handyman_warranty_claim_bindings
    (claim_id,certificate_id,certificate_number,certificate_source_sha256,certificate_pdf_sha256,certificate_manifest_version,
     item_line_id,coverage_kind,item_snapshot,starts_at,ends_at_exclusive,created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz,$11::timestamptz,$12)`,
  [claim.id, doc.id, doc.number, doc.sourceSha256, doc.pdfSha256, doc.manifestVersion,
    pin.itemLineId, pin.coverageKind, JSON.stringify(item), item.startsAt, item.endsAtExclusive, actor]);
}

/** Verify the frozen bytes/source and current accepted completion, never legacy BOTH. */
export async function assertCurrentClaimBinding(tx: PoolClient, claim: HandymanServiceWarrantyClaimRecord,
  expected?: ClaimCertificatePin): Promise<BindingRow> {
  const b = await binding(tx, claim.id);
  if (expected) samePin(pinFromBinding(b), expected);
  const doc = await requireCurrentWarrantyCertificateForClaim(tx, b.certificate_id, claim);
  if (doc.number !== b.certificate_number || doc.sourceSha256 !== b.certificate_source_sha256 ||
      doc.pdfSha256 !== b.certificate_pdf_sha256 || doc.manifestVersion !== b.certificate_manifest_version)
    throw conflict('The certificate version no longer matches the binding.');
  const item = doc.items.find(x => x.rootLineId === b.item_line_id);
  if (!item || (item.terms.coverage !== b.coverage_kind && item.terms.coverage !== 'BOTH') ||
      stableJson(item) !== stableJson(b.item_snapshot)) throw conflict('The agreed item terms are missing or ambiguous.');
  return b;
}

/** Submission uses the database statement time, never a caller-provided claim date. */
export async function assertSubmissionPeriod(tx: PoolClient, claim: HandymanServiceWarrantyClaimRecord): Promise<void> {
  await assertCurrentClaimBinding(tx, claim);
  const result = (await tx.query<{ valid: boolean }>(`SELECT hm_warranty_claim_in_period(statement_timestamp(),starts_at,ends_at_exclusive) AS valid
    FROM handyman_warranty_claim_bindings WHERE claim_id=$1`, [claim.id])).rows[0];
  if (!result?.valid) throw conflict('The actual claim submission is outside the contractual item period.');
}

async function assertAssessor(tx: PoolClient, claim: HandymanServiceWarrantyClaimRecord, actor: string): Promise<void> {
  const context = (await tx.query<{client_id:string; building_id:string; tenant_company_id:string}>(`SELECT client_id,building_id,tenant_company_id
    FROM handyman_execution_scopes WHERE id=$1`, [claim.executionScopeId])).rows[0];
  const user = (await tx.query<{status:string}>('SELECT status FROM users WHERE id=$1', [actor])).rows[0];
  const permissions = await permissionRepository.listActivePermissionCodesForUser(actor, tx);
  if (!context || user?.status !== 'ACTIVE' || !permissions.includes(HANDYMAN_WARRANTY_ASSESS_PERMISSION) ||
      actor === claim.openedByUserId || actor === claim.claimantUserId ||
      !(await canAccessBuildingScopedResource(actor, {clientId:context.client_id, buildingId:context.building_id}, tx))) throw forbidden();
  const pic = await tx.query(`SELECT 1 FROM tenant_pics WHERE tenant_company_id=$1 AND user_id=$2 AND status='ACTIVE'`,
    [context.tenant_company_id, actor]);
  if (pic.rowCount) throw forbidden();
  // A complaint recorder, named/self-confirmed reporter, uploader or importer
  // cannot independently review or decide that same complaint's claim.
  // Earlier staged migrations have no complaint table/function and therefore
  // no complaint participants; a partial installation must fail closed.
  const complaintFeature=(await tx.query<{fn:boolean;tbl:boolean}>(`SELECT
    to_regprocedure('hm_warranty_complaint_assessor_independent(uuid,uuid)') IS NOT NULL AS fn,
    to_regclass('handyman_warranty_complaint_claim_links') IS NOT NULL AS tbl`)).rows[0];
  if (complaintFeature.tbl && !complaintFeature.fn) throw forbidden();
  if (complaintFeature.fn) {
    const complaintIndependent = (await tx.query<{independent:boolean}>(
      'SELECT hm_warranty_complaint_assessor_independent($1,$2) AS independent', [claim.id,actor])).rows[0]?.independent;
    if (!complaintIndependent) throw forbidden();
  }
  // Serialize the decision with revocation/deactivation of the effective grant,
  // actor, and exact-Building assignment through commit.
  const held = await tx.query(`SELECT u.id FROM users u
    JOIN user_role_assignments ura ON ura.user_id=u.id AND ura.status='ACTIVE'
    JOIN roles r ON r.id=ura.role_id AND r.status='ACTIVE'
    JOIN role_permission_assignments rpa ON rpa.role_id=r.id AND rpa.status='ACTIVE'
    JOIN permissions p ON p.id=rpa.permission_id AND p.code=$2 AND p.status='ACTIVE'
    JOIN user_building_assignments uba ON uba.user_id=u.id AND uba.building_id=$3 AND uba.status='ACTIVE'
    JOIN buildings b ON b.id=uba.building_id AND b.status='ACTIVE'
    JOIN properties pr ON pr.id=b.property_id AND pr.client_id=$4
    WHERE u.id=$1 AND u.status='ACTIVE' FOR SHARE OF u,ura,r,rpa,p,uba,b,pr`,
  [actor,HANDYMAN_WARRANTY_ASSESS_PERMISSION,context.building_id,context.client_id]);
  if (!held.rowCount) throw forbidden();
}

/** Uses existing evidence records: locks the head, checks FINALIZE and immutable file metadata, and verifies the stored bytes. */
async function captureEvidence(tx: PoolClient, recordId: string, claim: HandymanServiceWarrantyClaimRecord,
  requireVerified: boolean): Promise<EvidenceSnapshot> {
  const r = (await tx.query<{id:string}>(`SELECT id FROM handyman_evidence_records WHERE id=$1 AND client_id=$2
    AND execution_scope_id=$3 FOR SHARE`, [recordId,claim.clientId,claim.executionScopeId])).rows[0];
  if (!r) throw conflict('Assessment evidence must belong to the exact claim Client and original execution scope.');
  const finalized = await handymanEvidenceQcRepository.findEvidenceFinalizeEventByRecord(tx, recordId);
  const files = await handymanEvidenceQcRepository.listEvidenceFilesByRecord(tx, recordId);
  let verified = Boolean(finalized && files.length);
  const storage = createEvidenceStorage();
  for (const f of files) {
    if (!isManagedStorageKey(f.storageKey) || !/^[0-9a-f]{64}$/.test(f.sha256Digest)) { verified = false; continue; }
    try {
      const data = await storage.get(f.storageKey);
      if (data.buffer.length !== f.byteSize || data.size !== f.byteSize || digest(data.buffer) !== f.sha256Digest) verified = false;
    } catch { verified = false; }
  }
  if (requireVerified && !verified) throw conflict('Claim and assessment evidence must be finalized, nonempty and byte-verified.');
  return { recordId, finalizeEventId:finalized?.id ?? null, byteVerified:verified,
    files:files.map(f=>({id:f.id,mediaKind:f.mediaKind,contentType:f.contentType,byteSize:f.byteSize,sha256Digest:f.sha256Digest})) };
}
function assessmentView(a: AssessmentRow) {
  return { id:a.id, claimId:a.claim_id, revision:a.revision, result:a.result, reason:a.reason,
    conditionsDisposition:a.conditions_disposition, conditionsReason:a.conditions_reason,
    exclusionsDisposition:a.exclusions_disposition, exclusionsReason:a.exclusions_reason,
    claimSubmittedAt:a.claim_submitted_at_text, claimEvidence:a.claim_evidence, reviewEvidence:a.review_evidence,
    reviewerUserId:a.reviewer_user_id, assessedAt:a.assessed_at.toISOString() };
}
function bindingView(b: BindingRow) {
  return { ...pinFromBinding(b), certificateNumber:b.certificate_number, item:b.item_snapshot,
    startsAt:b.starts_at_text, endsAtExclusive:b.ends_at_text, boundByUserId:b.created_by_user_id,
    boundAt:b.created_at.toISOString() };
}
function parseAssessment(input: RecordWarrantyClaimAssessmentInput) {
  const pin = parseClaimCertificatePin(input as unknown as Record<string,unknown>);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw AppError.validation('expectedRevision must be a nonnegative integer.');
  if (!['COVERED','REJECTED','NEEDS_EVIDENCE'].includes(input.result)) throw AppError.validation('A valid assessment result is required.');
  if (!['SATISFIED','NOT_SATISFIED','UNDETERMINED'].includes(input.conditionsDisposition)) throw AppError.validation('A conditions disposition is required.');
  if (!['NOT_APPLICABLE','APPLIES','UNDETERMINED'].includes(input.exclusionsDisposition)) throw AppError.validation('An exclusions disposition is required.');
  if (input.result === 'COVERED' && (input.conditionsDisposition !== 'SATISFIED' || input.exclusionsDisposition !== 'NOT_APPLICABLE'))
    throw conflict('COVERED requires explicit satisfied conditions and a recorded finding that exclusions do not apply.');
  return { ...pin, claimId:uuid(input.claimId,'claimId'), expectedRevision:input.expectedRevision, result:input.result,
    reason:text(input.reason,'reason'), conditionsDisposition:input.conditionsDisposition,
    conditionsReason:text(input.conditionsReason,'conditionsReason'), exclusionsDisposition:input.exclusionsDisposition,
    exclusionsReason:text(input.exclusionsReason,'exclusionsReason'), evidenceRecordId:uuid(input.evidenceRecordId,'evidenceRecordId'),
    idempotencyKey:text(input.idempotencyKey,'idempotencyKey',200) };
}

export async function recordWarrantyClaimAssessment(actorInput: string, input: RecordWarrantyClaimAssessmentInput) {
  const actor=uuid(actorInput,'actorUserId'), command=parseAssessment(input);
  const existing = await handymanServiceWarrantyClaimRepository.findClaimById(getPool(), command.claimId);
  if (!existing) throw handymanServiceWarrantyClaimNotFoundError();
  return withTransaction(async tx => {
    // Same ordering as certificate issue and claim transitions: scope, warranty, claim.
    await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE', [existing.executionScopeId]);
    await tx.query('SELECT id FROM handyman_service_warranties WHERE id=$1 FOR UPDATE', [existing.warrantyId]);
    const claim = await handymanServiceWarrantyClaimRepository.findClaimById(tx, command.claimId, true);
    if (!claim) throw handymanServiceWarrantyClaimNotFoundError();
    await assertAssessor(tx, claim, actor);
    const commandSha = digest(stableJson({actor,...command}));
    const replay = (await tx.query<AssessmentRow>(`${assessmentSelect} WHERE a.claim_id=$1 AND a.idempotency_key=$2`,
      [claim.id, command.idempotencyKey])).rows[0];
    if (replay) {
      if (replay.reviewer_user_id!==actor || replay.command_sha256!==commandSha) throw conflict('Assessment idempotency key belongs to different facts.');
      return { assessment:assessmentView(replay), replayed:true };
    }
    if (claim.status !== 'CLAIM_SUBMITTED' || !claim.evidenceRecordId) throw conflict('Only a submitted claim may be assessed.');
    await assertCurrentClaimBinding(tx, claim, command);
    const prior = (await tx.query<{revision:number}>(`SELECT COALESCE(max(revision),0)::int AS revision
      FROM handyman_warranty_claim_assessments WHERE claim_id=$1`,[claim.id])).rows[0].revision;
    if (prior!==command.expectedRevision) throw conflict('The assessment revision is stale.');
    const period = (await tx.query<{valid:boolean}>(`SELECT hm_warranty_claim_in_period(c.submitted_at,b.starts_at,b.ends_at_exclusive) AS valid
      FROM handyman_service_warranty_claims c JOIN handyman_warranty_claim_bindings b ON b.claim_id=c.id WHERE c.id=$1`,[claim.id])).rows[0];
    if (command.result==='COVERED' && !period?.valid) throw conflict('The actual submission is outside the contractual item period.');
    const verified = command.result!=='NEEDS_EVIDENCE';
    const claimEvidence=await captureEvidence(tx,claim.evidenceRecordId,claim,verified);
    const reviewEvidence=command.evidenceRecordId===claim.evidenceRecordId
      ? claimEvidence : await captureEvidence(tx,command.evidenceRecordId,claim,verified);
    const result = await tx.query<AssessmentRow>(`INSERT INTO handyman_warranty_claim_assessments
      (id,claim_id,revision,result,reason,conditions_disposition,conditions_reason,exclusions_disposition,exclusions_reason,
       claim_submitted_at,claim_evidence,review_evidence,reviewer_user_id,idempotency_key,command_sha256)
      SELECT $1,c.id,$2,$3,$4,$5,$6,$7,$8,c.submitted_at,$9::jsonb,$10::jsonb,$11,$12,$13
      FROM handyman_service_warranty_claims c WHERE c.id=$14
      RETURNING *,to_char(claim_submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS claim_submitted_at_text`,
    [randomUUID(),prior+1,command.result,command.reason,command.conditionsDisposition,command.conditionsReason,
      command.exclusionsDisposition,command.exclusionsReason,JSON.stringify(claimEvidence),JSON.stringify(reviewEvidence),actor,
      command.idempotencyKey,commandSha,claim.id]);
    return { assessment:assessmentView(result.rows[0]), replayed:false };
  });
}

/** Recheck the exact latest assessment, item, actual filing date and bytes under the claim lock. */
export async function requireClaimDecisionAssessment(tx: PoolClient, claim: HandymanServiceWarrantyClaimRecord,
  actor: string, assessmentInput: unknown, action: 'APPROVE' | 'REJECT'): Promise<string> {
  await assertAssessor(tx,claim,actor);
  const assessmentId=uuid(assessmentInput,'assessmentId');
  await assertCurrentClaimBinding(tx,claim);
  const latest=(await tx.query<AssessmentRow>(`${assessmentSelect} WHERE a.claim_id=$1 ORDER BY a.revision DESC LIMIT 1`,[claim.id])).rows[0];
  if (!latest || latest.id!==assessmentId || latest.result!==(action==='APPROVE'?'COVERED':'REJECTED'))
    throw conflict('The latest matching assessment must be explicitly pinned to the decision.');
  const period=(await tx.query<{valid:boolean}>(`SELECT hm_warranty_claim_in_period(c.submitted_at,b.starts_at,b.ends_at_exclusive) AS valid
    FROM handyman_service_warranty_claims c JOIN handyman_warranty_claim_bindings b ON b.claim_id=c.id WHERE c.id=$1`,[claim.id])).rows[0];
  if (action==='APPROVE' && !period?.valid) throw conflict('The actual claim date is outside the contractual item period.');
  const claimEvidence=await captureEvidence(tx,latest.claim_evidence.recordId,claim,true);
  const reviewEvidence=latest.review_evidence.recordId===claimEvidence.recordId ? claimEvidence
    : await captureEvidence(tx,latest.review_evidence.recordId,claim,true);
  if (claim.evidenceRecordId!==claimEvidence.recordId || stableJson(claimEvidence)!==stableJson(latest.claim_evidence) ||
      stableJson(reviewEvidence)!==stableJson(latest.review_evidence)) throw conflict('Assessment evidence has changed or failed verification.');
  return latest.id;
}

/** Safe internal projection for a later rework decision. Historic unbound approvals return null. */
export async function readCoveredWarrantyClaimApproval(tx: PoolClient, claimId: string) {
  const covered=(await tx.query<{covered:boolean}>('SELECT hm_warranty_claim_has_covered_approval($1) AS covered',[claimId])).rows[0]?.covered;
  if (!covered) return null;
  const b=await binding(tx,claimId);
  const a=(await tx.query<AssessmentRow>(`${assessmentSelect} JOIN handyman_service_warranty_claims c
    ON c.decision_assessment_id=a.id AND c.id=a.claim_id WHERE c.id=$1`,[claimId])).rows[0];
  const claim=await handymanServiceWarrantyClaimRepository.findClaimById(tx,claimId);
  if (!a || !claim) return null;
  try {
    await assertCurrentClaimBinding(tx,claim);
    const claimEvidence=await captureEvidence(tx,a.claim_evidence.recordId,claim,true);
    const reviewEvidence=a.review_evidence.recordId===claimEvidence.recordId ? claimEvidence
      : await captureEvidence(tx,a.review_evidence.recordId,claim,true);
    if (stableJson(claimEvidence)!==stableJson(a.claim_evidence) || stableJson(reviewEvidence)!==stableJson(a.review_evidence)) return null;
  } catch { return null; }
  return { binding:bindingView(b), assessment:assessmentView(a) };
}

/** Read-only, exact-Building assessment history. No internal storage keys are exposed. */
export async function readWarrantyClaimAssessment(actorInput: string, claimInput: string) {
  const actor=uuid(actorInput,'actorUserId'), claimId=uuid(claimInput,'claimId');
  const existing=await handymanServiceWarrantyClaimRepository.findClaimById(getPool(),claimId);
  if (!existing) throw handymanServiceWarrantyClaimNotFoundError();
  return withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const claim=await handymanServiceWarrantyClaimRepository.findClaimById(tx,claimId);
    if (!claim) throw handymanServiceWarrantyClaimNotFoundError();
    const context=(await tx.query<{client_id:string;building_id:string}>(
      'SELECT client_id,building_id FROM handyman_execution_scopes WHERE id=$1',[claim.executionScopeId])).rows[0];
    const user=(await tx.query<{status:string}>('SELECT status FROM users WHERE id=$1',[actor])).rows[0];
    const permissions=await permissionRepository.listActivePermissionCodesForUser(actor,tx);
    if (!context || user?.status!=='ACTIVE' || !permissions.some(p=>p===HANDYMAN_WARRANTY_ASSESS_PERMISSION || p==='tenant_company.read') ||
      !(await canAccessBuildingScopedResource(actor,{clientId:context.client_id,buildingId:context.building_id},tx))) throw forbidden();
    const found=(await tx.query<BindingRow>(bindingSelect,[claim.id])).rows[0];
    const assessments=(await tx.query<AssessmentRow>(`${assessmentSelect} WHERE a.claim_id=$1 ORDER BY a.revision`,[claim.id])).rows;
    const covered=await readCoveredWarrantyClaimApproval(tx,claim.id);
    return {claimId:claim.id,claimStatus:claim.status,binding:found?bindingView(found):null,
      assessments:assessments.map(assessmentView),coveredApproval:covered};
  });
}
