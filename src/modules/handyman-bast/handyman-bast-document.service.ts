import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { resolveBuildingsForUser } from '../building-assignments';
import { permissionRepository } from '../permissions';
import { createEvidenceStorage } from '../evidence/storage';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from '../handyman-care-workspace/care-workspace.service';
import { parseCareHandymanPaymentProofSelection } from '../handyman-care-workspace/care-workspace-payment-proof.service';
import { WORKSPACE_OCCUPANCY_CTES } from '../handyman-care-workspace/care-workspace-occupancies.repository';
import { resolveHandymanDocumentIssuerSnapshot } from '../handyman-documents/handyman-document-issuer.service';
import { handymanDocumentIssuerProfileRepository } from '../handyman-documents/handyman-document-issuer.repository';
import { resolveHandymanDocumentSettingsSnapshot } from '../handyman-documents/handyman-document-settings.service';
import { renderHandymanDocumentPdf } from '../handyman-documents/handyman-document-pdf';
import type { HandymanDocumentLocale } from '../handyman-documents/handyman-document-pdf.types';
import type { HandymanDocumentIssuerSnapshot } from '../handyman-documents/handyman-document-issuer.types';
import type { HandymanDocumentSettingsSnapshot } from '../handyman-documents/handyman-document-settings.types';
import type { ManifestSnapshot, requireVerifiedCompletionForIssue } from '../handyman-completion-manifest/handyman-completion-manifest.service';
import { addText, blocks, exactText } from '../handyman-quotations/handyman-quotation-document.service';
import type { HandymanBastEventRecord, HandymanBastRecord } from './handyman-bast.types';

const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 28 * 1024 * 1024;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const conflict = (message: string) => new AppError({ code: ERROR_CODES.HANDYMAN_BAST_DOCUMENT_INVALID, statusCode: 409, message });
const integrity = () => new AppError({ code: ERROR_CODES.HANDYMAN_BAST_DOCUMENT_INTEGRITY_ERROR, statusCode: 409,
  message: 'The official BAST PDF or frozen source failed integrity verification.' });
const notFound = () => AppError.notFound('Official BAST PDF not found.');
function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) throw AppError.validation(`Invalid ${name}.`);
  return value.toLowerCase();
}

type Customer = { clientId: string; requestId: string; buildingId: string; buildingName: string;
  propertyId: string; tenantCompanyId: string; tenantName: string; legalName: string | null;
  tenantPicName: string | null; spaceId: string | null; spaceName: string | null };
type Unit = { id: string; code: string; name: string; symbol: string };
type Evidence = { id: string; reference: string; sha256: string; mimeType: string; byteSize: number; attachmentName: string; kind: 'EXECUTION' | 'QC' };
type Source = { schema: 'HANDYMAN_BAST_OFFICIAL_V1'; status: 'ISSUED';
  issuance: { id: string; number: string; bastId: string; eventId: string; actorUserId: string; issuedAt: string };
  customer: Customer; executionScopeId: string;
  approvedQuotation: { id: string; versionId: string; versionNumber: number; decisionId: string };
  manifest: { id: string; version: number; sha256: string; snapshot: ManifestSnapshot };
  verification: { id: string; verifiedByUserId: string; verifiedAt: string; qcRunId: string;
    qcRunVersion: number; qcFinishEventId: string; qcFinishedByUserId: string; qcFinishedAt: string };
  evidence: Evidence[]; units: Unit[]; issuer: HandymanDocumentIssuerSnapshot; settings: HandymanDocumentSettingsSnapshot };
export type OfficialBastStored = { id: string; bast_id: string; issue_event_id: string; client_id: string; building_id: string;
  request_id: string; execution_scope_id: string; tenant_company_id: string; completion_verification_id: string;
  manifest_id: string; manifest_version: number; manifest_sha256: string; qc_run_id: string; qc_run_version: number;
  qc_finish_event_id: string; issuer_profile_id: string; settings_id: string; document_number: string;
  issued_by_user_id: string; issued_at: Date; source_snapshot: Source; source_canonical: string; source_sha256: string;
  pdf_filename: string; pdf_bytes: Buffer; pdf_size: number; pdf_sha256: string };
type Stored = OfficialBastStored;
type EvidenceRow = { id: string; client_id: string; building_id: string; tenant_company_id: string;
  handyman_request_id: string; execution_scope_id: string | null; purpose: string; upload_status: string;
  attachment_reference: string; mime_type: string; verified_byte_size: number; sha256_checksum: string; storage_key: string };

/** Exact, self-contained evidence: bytes are re-hashed at issue, named by ID,
 * and attached to the PDF. A missing, changed, wrong-scope or too-large file
 * aborts the entire ISSUE rather than silently dropping proof. */
async function collectEvidence(tx: PoolClient, manifest: ManifestSnapshot, qcRunId: string) {
  const proof = manifest.items.flatMap(item => item.execution);
  const executionIds = [...new Set(proof.map(p => p.evidenceId))];
  const qcRows = (await tx.query<{ evidence_upload_id: string }>(
    'SELECT evidence_upload_id FROM handyman_qc_run_evidence WHERE run_id=$1 ORDER BY evidence_upload_id', [qcRunId])).rows;
  if (!qcRows.length) throw conflict('The reviewed QC PASS has no verified QC evidence.');
  const qcIds = [...new Set(qcRows.map(r => r.evidence_upload_id))];
  const all = [...new Set([...executionIds, ...qcIds])].sort();
  const rows = (await tx.query<EvidenceRow>(`SELECT id,client_id,building_id,tenant_company_id,handyman_request_id,
    execution_scope_id,purpose,upload_status,attachment_reference,mime_type,verified_byte_size,sha256_checksum,storage_key
    FROM handyman_field_evidence_uploads WHERE id=ANY($1::uuid[]) FOR SHARE`, [all])).rows;
  if (rows.length !== all.length) throw conflict('Verified execution or QC evidence is unavailable.');
  const byId = new Map(rows.map(r => [r.id, r]));
  const evidence: Evidence[] = [], attachments: { name: string; mimeType: string; bytes: Buffer }[] = [];
  let total = 0;
  const ext: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
  const storage = createEvidenceStorage();
  for (const id of all) {
    const r = byId.get(id)!;
    const kind = executionIds.includes(id) ? 'EXECUTION' : 'QC';
    if (executionIds.includes(id) && qcIds.includes(id)) throw conflict('Evidence cannot be both execution and QC evidence.');
    if (r.client_id !== manifest.clientId || r.building_id !== manifest.buildingId ||
        r.handyman_request_id !== manifest.requestId || r.execution_scope_id !== manifest.executionScopeId ||
        r.upload_status !== 'VERIFIED' || r.purpose !== (kind === 'EXECUTION' ? 'BEFORE_AFTER_WORK' : 'QC_EVIDENCE') ||
        !r.attachment_reference || !r.sha256_checksum || !ext[r.mime_type] || r.verified_byte_size <= 0 ||
        proof.some(p => p.evidenceId === id && (p.evidenceReference !== r.attachment_reference || p.evidenceSha256 !== r.sha256_checksum))) {
      throw conflict('Evidence does not match the reviewed request, execution scope or digest.');
    }
    let bytes: Buffer;
    try { bytes = (await storage.get(r.storage_key)).buffer; }
    catch { throw conflict('Verified evidence bytes are unavailable.'); }
    if (bytes.length !== r.verified_byte_size || sha(bytes) !== r.sha256_checksum) throw conflict('Verified evidence bytes failed SHA-256 verification.');
    total += bytes.length;
    if (total > MAX_EVIDENCE_BYTES) throw conflict('Verified evidence exceeds the BAST PDF attachment capacity.');
    const name = `${kind.toLowerCase()}-evidence-${id}.${ext[r.mime_type]}`;
    evidence.push({ id, reference: r.attachment_reference, sha256: r.sha256_checksum, mimeType: r.mime_type,
      byteSize: r.verified_byte_size, attachmentName: name, kind });
    attachments.push({ name, mimeType: r.mime_type, bytes });
  }
  return { evidence, attachments };
}

async function renderOfficial(s: Source, sourceHash: string, attachments: { name: string; mimeType: string; bytes: Buffer }[]) {
  const lineItems: { description: string }[] = [];
  s.manifest.snapshot.items.forEach((item, index) => {
    const rows: string[] = [];
    addText(rows, `Item ${index + 1} ${item.lineType}`, item.description);
    const unit = s.units.find(u => u.id === item.uomId);
    if (!unit) throw conflict('The completion item unit is unavailable.');
    addText(rows, 'Status', item.status); addText(rows, 'Actual quantity', `${item.actualQty} ${unit.symbol}`);
    addText(rows, 'Approved quantity', `${item.approvedQty} ${unit.symbol}`);
    addText(rows, 'Original approved quantity', `${item.originalApprovedQty} ${unit.symbol}`);
    addText(rows, 'Unit ID', item.uomId); addText(rows, 'Unit name at issue', unit.name); addText(rows, 'Unit code', unit.code); addText(rows, 'Quotation version', item.quotationVersionId);
    addText(rows, 'Quotation line', item.quotationLineId); addText(rows, 'Variation ID', item.variationId);
    addText(rows, 'Approved variation version', item.approvedVariationVersion);
    item.execution.forEach((p, i) => {
      addText(rows, `Execution ${i + 1}`, `${p.source} ${p.id}`); addText(rows, 'Lead user', p.leadUserId);
      addText(rows, 'Session', p.sessionId); addText(rows, 'Actual quantity in execution', p.actualQty);
      addText(rows, 'Evidence reference', p.evidenceReference); addText(rows, 'Evidence SHA-256', p.evidenceSha256);
      addText(rows, 'Evidence attachment', s.evidence.find(e => e.id === p.evidenceId)?.attachmentName);
    });
    rows.forEach(description => lineItems.push({ description }));
  });
  const scope: string[] = [], review: string[] = [], evidence: string[] = [], terms: string[] = [];
  addText(scope, 'Request', s.customer.requestId); addText(scope, 'Client', s.customer.clientId);
  addText(scope, 'Building ID', s.customer.buildingId); addText(scope, 'Building', s.customer.buildingName);
  addText(scope, 'Tenant ID', s.customer.tenantCompanyId); addText(scope, 'Tenant', s.customer.tenantName);
  addText(scope, 'Legal name', s.customer.legalName); addText(scope, 'Contact', s.customer.tenantPicName);
  addText(scope, 'Space ID', s.customer.spaceId); addText(scope, 'Space', s.customer.spaceName);
  addText(scope, 'Execution scope', s.executionScopeId); addText(scope, 'Approved quotation', s.approvedQuotation.id);
  addText(scope, 'Approved quotation version', s.approvedQuotation.versionId);
  addText(scope, 'Quotation version number', s.approvedQuotation.versionNumber);
  addText(scope, 'Tenant quotation approval', s.approvedQuotation.decisionId);
  s.manifest.snapshot.approvedVariations.forEach((v, i) => addText(scope, `Approved variation ${i + 1}`, v));
  addText(review, 'BAST ID', s.issuance.bastId); addText(review, 'ISSUE event', s.issuance.eventId);
  addText(review, 'Issued by', s.issuance.actorUserId); addText(review, 'Issued at UTC', s.issuance.issuedAt);
  addText(review, 'Manifest ID', s.manifest.id); addText(review, 'Manifest version', s.manifest.version);
  addText(review, 'Manifest SHA-256', s.manifest.sha256); addText(review, 'Completion review', s.verification.id);
  addText(review, 'Reviewed by', s.verification.verifiedByUserId); addText(review, 'Reviewed at UTC', s.verification.verifiedAt);
  addText(review, 'QC PASS run', s.verification.qcRunId); addText(review, 'QC PASS version', s.verification.qcRunVersion);
  addText(review, 'QC FINISH event', s.verification.qcFinishEventId); addText(review, 'QC finished by', s.verification.qcFinishedByUserId);
  addText(review, 'QC finished at UTC', s.verification.qcFinishedAt);
  s.manifest.snapshot.sessions.forEach((session, i) => addText(review, `Completed session ${i + 1}`, session));
  s.evidence.forEach((e, i) => {
    addText(evidence, `Evidence ${i + 1} ${e.kind}`, e.reference);
    addText(evidence, 'SHA-256', e.sha256); addText(evidence, 'Attached file', e.attachmentName);
    addText(evidence, 'Type / size', `${e.mimeType} / ${e.byteSize} bytes`);
  });
  s.settings.termsLines.forEach((line, i) => addText(terms, `Term ${i + 1}`, line));
  addText(terms, 'Payment note', s.settings.paymentNote); addText(terms, 'Warranty note', s.settings.warrantyNote);
  addText(terms, 'Contact note', s.settings.contactNote);
  addText(terms, 'Footer note', s.settings.footerNote);
  addText(terms, 'Designated issuer (not a signature)', `${s.settings.signatoryName} / ${s.settings.signatoryTitle}`);
  addText(terms, 'Source SHA-256', sourceHash);
  const allTerms = [...blocks('Request and approved scope', scope), ...blocks('Completion and QC review', review),
    ...blocks('Verified evidence attachments', evidence), ...blocks('BAST terms', terms)];
  if (lineItems.length > 400 || allTerms.length > 12) throw conflict('The complete BAST source exceeds PDF layout capacity.');
  const rendered = await renderHandymanDocumentPdf({ locale: s.settings.language, utcOffsetMinutes: 0,
    document: { kind: 'BAST', number: s.issuance.number, version: s.manifest.version,
      issueDate: s.issuance.issuedAt, reference: s.customer.requestId },
    issuer: { name: exactText(s.issuer.legalName), addressLines: [exactText(s.issuer.registeredAddress),
      exactText(`${s.issuer.city}, ${s.issuer.province} ${s.issuer.postalCode}`)],
      phone: exactText(s.issuer.phone), email: exactText(s.issuer.email) },
    recipient: { name: exactText(s.customer.tenantName) },
    property: { name: exactText(s.customer.buildingName), lines: s.customer.spaceName ? [exactText(s.customer.spaceName)] : [] },
    lineItems, terms: allTerms,
    status: { value: 'ISSUED', lines: ['Tenant acceptance is not recorded in this issued document.'] },
  }, { filename: `bast-${s.issuance.id}.pdf` });
  const pdf = await PDFDocument.load(rendered.bytes, { updateMetadata: false });
  for (const a of attachments) await pdf.attach(a.bytes, a.name, { mimeType: a.mimeType,
    description: 'Verified evidence; SHA-256 is listed in the document.' });
  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false }));
  if (bytes.length < 1 || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString() !== '%PDF-') {
    throw conflict('The complete evidence-backed BAST PDF exceeds storage capacity.');
  }
  return { bytes, filename: rendered.filename, fileSize: bytes.length, checksum: sha(bytes) };
}

/** Run ONLY inside the same locked transaction that changed DRAFT to ISSUED
 * and appended its ISSUE event. No lazy/historical document generation. */
export async function createOfficialBastDocument(tx: PoolClient, bast: HandymanBastRecord, event: HandymanBastEventRecord,
  completion: Awaited<ReturnType<typeof requireVerifiedCompletionForIssue>>): Promise<void> {
  if (bast.status !== 'ISSUED' || !bast.issuedAt || event.eventType !== 'ISSUE' || !event.actorUserId || !bast.qcRunId) throw integrity();
  await tx.query('SET LOCAL synchronous_commit = on');
  const durable = (await tx.query<{ fsync: string; pages: string; commit: string; replica: boolean }>(`SELECT
    current_setting('fsync') AS fsync,current_setting('full_page_writes') AS pages,
    current_setting('synchronous_commit') AS commit,pg_is_in_recovery() AS replica`)).rows[0];
  if (durable?.fsync !== 'on' || durable.pages !== 'on' || durable.commit !== 'on' || durable.replica) {
    throw new AppError({ code: ERROR_CODES.HANDYMAN_BAST_DOCUMENT_DURABILITY_UNAVAILABLE, statusCode: 503,
      message: 'Official BAST PDFs require durable primary PostgreSQL storage.' });
  }
  await handymanDocumentIssuerProfileRepository.lockClientAuthority(tx, bast.clientId);
  const langs = (await tx.query<{ language: HandymanDocumentLocale }>(`SELECT language FROM handyman_document_issuer_document_settings
    WHERE client_id=$1 AND document_kind='BAST' AND status='ACTIVE' ORDER BY language`, [bast.clientId])).rows;
  if (langs.length !== 1) throw conflict('Exactly one active BAST document settings language must be configured.');
  const issuer = await resolveHandymanDocumentIssuerSnapshot(bast.clientId, tx);
  const settings = await resolveHandymanDocumentSettingsSnapshot(bast.clientId, 'BAST', langs[0]!.language, tx);
  for (const [table, id] of [['handyman_document_issuer_profiles', issuer.profileId],
    ['handyman_document_issuer_document_settings', settings.settingsId]] as const) {
    if ((await tx.query(`SELECT id FROM ${table} WHERE id=$1 AND status='ACTIVE' FOR SHARE`, [id])).rowCount !== 1) {
      throw conflict('The BAST issuer or settings changed during ISSUE.');
    }
  }
  const customer = (await tx.query<Customer>(`SELECT s.client_id AS "clientId",r.id AS "requestId",
    b.id AS "buildingId",b.name AS "buildingName",p.id AS "propertyId",tc.id AS "tenantCompanyId",
    tc.tenant_name AS "tenantName",tc.legal_name AS "legalName",tp.pic_name AS "tenantPicName",
    sp.id AS "spaceId",sp.name AS "spaceName"
    FROM handyman_execution_scopes s JOIN handyman_service_requests r ON r.id=s.handyman_request_id
      AND r.client_id=s.client_id AND r.building_id=s.building_id AND r.tenant_company_id=s.tenant_company_id
    JOIN buildings b ON b.id=s.building_id JOIN properties p ON p.id=b.property_id AND p.client_id=s.client_id
    JOIN tenant_companies tc ON tc.id=s.tenant_company_id AND tc.client_id=s.client_id
    LEFT JOIN tenant_pics tp ON tp.id=r.tenant_pic_id AND tp.tenant_company_id=tc.id
    LEFT JOIN spaces sp ON sp.id=r.space_id LEFT JOIN rooms rm ON rm.id=sp.room_id
    LEFT JOIN areas a ON a.id=rm.area_id LEFT JOIN floors f ON f.id=a.floor_id
    WHERE s.id=$1 AND (r.space_id IS NULL OR (sp.id IS NOT NULL AND f.building_id=b.id))`, [bast.executionScopeId])).rows[0];
  if (!customer?.tenantName || !customer.buildingName || (customer.spaceId && !customer.spaceName)) {
    throw conflict('The exact request, tenant and Building context is unavailable.');
  }
  const quotation = (await tx.query<Source['approvedQuotation']>(`SELECT s.quotation_id AS id,
    qv.id AS "versionId",qv.version_number AS "versionNumber",d.id AS "decisionId"
    FROM handyman_execution_scopes s JOIN handyman_quotation_versions qv
      ON qv.id=s.approved_quotation_version_id AND qv.quotation_id=s.quotation_id
    JOIN handyman_quotation_decisions d ON d.id=s.quotation_decision_id AND d.quotation_id=s.quotation_id
      AND d.quotation_version_id=qv.id AND d.decision='APPROVE' AND d.tenant_company_id=s.tenant_company_id
      AND d.tenant_pic_id IS NOT DISTINCT FROM s.tenant_pic_id AND d.client_id=s.client_id
    WHERE s.id=$1`, [bast.executionScopeId])).rows[0];
  const row = (await tx.query<{ snapshot: ManifestSnapshot; verified_by: string; verified_at: Date;
    qc_run_version: number; qc_finish_id: string; qc_finished_by: string; qc_finished_at: Date }>(`SELECT
      m.source_snapshot AS snapshot,v.verified_by_user_id AS verified_by,v.verified_at,v.qc_run_version,
      f.id AS qc_finish_id,f.actor_user_id AS qc_finished_by,f.occurred_at AS qc_finished_at
    FROM handyman_completion_verifications v JOIN handyman_completion_manifests m ON m.id=v.manifest_id
    JOIN handyman_qc_runs q ON q.id=v.qc_run_id AND q.status='PASSED' AND q.version=v.qc_run_version
    JOIN handyman_qc_run_events f ON f.id=v.qc_finish_event_id AND f.run_id=q.id
      AND f.event_type='FINISH' AND f.metadata->>'outcome'='PASSED'
    WHERE v.id=$1 AND v.execution_scope_id=$2 AND v.manifest_id=$3 AND v.manifest_version=$4
      AND v.manifest_sha256=$5 AND v.qc_run_id=$6`, [completion.verificationId, bast.executionScopeId,
    completion.manifestId, completion.manifestVersion, completion.manifestSha256, bast.qcRunId])).rows[0];
  if (!quotation || !row || row.snapshot.clientId !== customer.clientId || row.snapshot.requestId !== customer.requestId ||
      row.snapshot.buildingId !== customer.buildingId || row.snapshot.executionScopeId !== bast.executionScopeId ||
      row.snapshot.approvedQuotationVersionId !== quotation.versionId || !row.snapshot.items.length ||
      sha(stableJson(row.snapshot)) !== completion.manifestSha256) throw conflict('The exact approved scope and verified completion manifest are unavailable.');
  const unitIds = [...new Set(row.snapshot.items.map(item => item.uomId))].sort();
  const units = (await tx.query<Unit>(`SELECT id,code,name,symbol FROM units_of_measure
    WHERE client_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`, [customer.clientId, unitIds])).rows;
  if (units.length !== unitIds.length || units.some(u => !u.name || !u.symbol || !u.code)) {
    throw conflict('An authoritative completion unit is unavailable.');
  }
  const { evidence, attachments } = await collectEvidence(tx, row.snapshot, bast.qcRunId);
  // A proof must also belong to the same represented tenant, not merely the same request.
  const tenantMatch = await tx.query(`SELECT 1 FROM handyman_field_evidence_uploads
    WHERE id=ANY($1::uuid[]) AND tenant_company_id<>$2 LIMIT 1`, [evidence.map(e => e.id), customer.tenantCompanyId]);
  if (tenantMatch.rowCount) throw conflict('Evidence belongs to a different tenant.');
  const allocation = (await tx.query<{ number: string }>(`SELECT nextval('handyman_bast_official_document_number_seq')::text AS number`)).rows[0]!;
  const source: Source = { schema: 'HANDYMAN_BAST_OFFICIAL_V1', status: 'ISSUED',
    issuance: { id: randomUUID(), number: `${settings.documentPrefix}-${allocation.number.padStart(10, '0')}`,
      bastId: bast.id, eventId: event.id, actorUserId: event.actorUserId, issuedAt: bast.issuedAt.toISOString() },
    customer, executionScopeId: bast.executionScopeId, approvedQuotation: quotation,
    manifest: { id: completion.manifestId, version: completion.manifestVersion, sha256: completion.manifestSha256, snapshot: row.snapshot },
    verification: { id: completion.verificationId, verifiedByUserId: row.verified_by, verifiedAt: row.verified_at.toISOString(),
      qcRunId: bast.qcRunId, qcRunVersion: row.qc_run_version, qcFinishEventId: row.qc_finish_id,
      qcFinishedByUserId: row.qc_finished_by, qcFinishedAt: row.qc_finished_at.toISOString() }, evidence, units, issuer, settings };
  const canonical = stableJson(source), digest = sha(canonical);
  const pdf = await renderOfficial(source, digest, attachments);
  const stored = (await tx.query<Stored>(`INSERT INTO handyman_bast_official_documents
    (id,bast_id,issue_event_id,client_id,building_id,request_id,execution_scope_id,tenant_company_id,
     completion_verification_id,manifest_id,manifest_version,manifest_sha256,qc_run_id,qc_run_version,qc_finish_event_id,
     issuer_profile_id,settings_id,document_number,issued_by_user_id,issued_at,source_snapshot,source_canonical,
     source_sha256,pdf_filename,pdf_bytes,pdf_size,pdf_sha256)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,b.issued_at,
      $20::text::jsonb,$20::text,$21,$22,$23,$24,$25 FROM handyman_bast_documents b WHERE b.id=$2 RETURNING *`,
  [source.issuance.id, bast.id, event.id, customer.clientId, customer.buildingId, customer.requestId, bast.executionScopeId,
    customer.tenantCompanyId, completion.verificationId, completion.manifestId, completion.manifestVersion, completion.manifestSha256,
    bast.qcRunId, row.qc_run_version, row.qc_finish_id, issuer.profileId, settings.settingsId, source.issuance.number,
    event.actorUserId, canonical, digest, pdf.filename, pdf.bytes, pdf.fileSize, pdf.checksum])).rows[0];
  if (!stored) throw integrity();
  verifyStoredOfficialBast(stored);
}

export function verifyStoredOfficialBast(row: OfficialBastStored): void {
  try {
    const s = row.source_snapshot;
    if (!Buffer.isBuffer(row.pdf_bytes) || row.pdf_bytes.length !== row.pdf_size || row.pdf_size < 1 || row.pdf_size > MAX_PDF_BYTES ||
        row.pdf_bytes.subarray(0, 5).toString() !== '%PDF-' || sha(row.pdf_bytes) !== row.pdf_sha256 ||
        !/^[a-z0-9-]+\.pdf$/.test(row.pdf_filename) || stableJson(s) !== row.source_canonical || sha(row.source_canonical) !== row.source_sha256 ||
        s.schema !== 'HANDYMAN_BAST_OFFICIAL_V1' || s.status !== 'ISSUED' || s.issuance.id !== row.id ||
        s.issuance.bastId !== row.bast_id || s.issuance.eventId !== row.issue_event_id || s.issuance.number !== row.document_number ||
        s.issuance.issuedAt !== row.issued_at.toISOString() || s.issuance.actorUserId !== row.issued_by_user_id ||
        s.customer.clientId !== row.client_id || s.customer.requestId !== row.request_id || s.customer.buildingId !== row.building_id ||
        s.customer.tenantCompanyId !== row.tenant_company_id || s.executionScopeId !== row.execution_scope_id ||
        s.manifest.id !== row.manifest_id || s.manifest.version !== row.manifest_version || s.manifest.sha256 !== row.manifest_sha256 ||
        sha(stableJson(s.manifest.snapshot)) !== row.manifest_sha256 || s.verification.id !== row.completion_verification_id ||
        s.verification.qcRunId !== row.qc_run_id || s.verification.qcRunVersion !== row.qc_run_version ||
        s.verification.qcFinishEventId !== row.qc_finish_event_id || s.issuer.profileId !== row.issuer_profile_id ||
        s.settings.settingsId !== row.settings_id || !s.manifest.snapshot.items.length ||
        s.manifest.snapshot.items.some(item => !s.units.some(unit => unit.id === item.uomId))) throw integrity();
  } catch { throw integrity(); }
}
function asDownload(row: Stored) {
  verifyStoredOfficialBast(row);
  return { id: row.id, number: row.document_number, filename: row.pdf_filename, fileSize: row.pdf_size,
    sourceChecksum: row.source_sha256, pdfChecksum: row.pdf_sha256, bytes: row.pdf_bytes };
}

/** Local active Building Care, never tenant acceptance or a delivery claim. */
export async function downloadOfficialBastDocument(actorInput: string, bastInput: string) {
  const actor = uuid(actorInput, 'actorUserId'), bastId = uuid(bastInput, 'bastId');
  return withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const context = (await tx.query<{ client_id: string; building_id: string; user_status: string }>(`SELECT
      s.client_id,s.building_id,u.status AS user_status FROM handyman_bast_documents b
      JOIN handyman_execution_scopes s ON s.id=b.execution_scope_id AND s.client_id=b.client_id
      JOIN users u ON u.id=$2 WHERE b.id=$1`, [bastId, actor])).rows[0];
    if (!context) throw notFound();
    const permissions = await permissionRepository.listActivePermissionCodesForUser(actor, tx);
    if (context.user_status !== 'ACTIVE' || !permissions.includes('handyman.care.building')) {
      throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403, message: 'Active Building Care authority is required.' });
    }
    const buildings = await resolveBuildingsForUser(actor, tx);
    if (!buildings.some(b => b.client?.id === context.client_id && b.building.id === context.building_id)) throw notFound();
    const row = (await tx.query<Stored>(`SELECT * FROM handyman_bast_official_documents
      WHERE bast_id=$1 AND client_id=$2 AND building_id=$3`, [bastId, context.client_id, context.building_id])).rows[0];
    if (!row) throw notFound();
    return asDownload(row);
  });
}

/** Current Care workspace grant and exact represented occupancy are checked in
 * the SAME statement as the immutable artifact read. */
export async function downloadOfficialBastDocumentForCare(token: string, requestInput: unknown, bastInput: unknown, query: unknown) {
  const principal = await resolveCareWorkspacePrincipal(token);
  const selection = parseCareHandymanPaymentProofSelection(query);
  const requestId = uuid(requestInput, 'requestId'), bastId = uuid(bastInput, 'bastId');
  const result = await getPool().query<Stored & { authenticated: boolean }>(`${WORKSPACE_OCCUPANCY_CTES}
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,d.* FROM (SELECT 1) singleton
    LEFT JOIN LATERAL (
      SELECT doc.* FROM handyman_service_requests r
      JOIN records c ON c."clientId"=r.client_id AND c."tenantCompanyId"=r.tenant_company_id
        AND c."buildingId"=r.building_id AND c."spaceId" IS NOT DISTINCT FROM r.space_id
      JOIN handyman_execution_scopes s ON s.handyman_request_id=r.id AND s.client_id=r.client_id
        AND s.building_id=r.building_id AND s.tenant_company_id=r.tenant_company_id
      JOIN handyman_bast_documents b ON b.execution_scope_id=s.id AND b.client_id=r.client_id
      JOIN handyman_bast_official_documents doc ON doc.bast_id=b.id AND doc.execution_scope_id=s.id
        AND doc.request_id=r.id AND doc.client_id=r.client_id AND doc.building_id=r.building_id
        AND doc.tenant_company_id=r.tenant_company_id
      WHERE $5::text IS NULL AND $6::integer=1 AND r.id=$10 AND b.id=$11
        AND r.tenant_company_id=$7 AND r.building_id=$8 AND r.space_id IS NOT DISTINCT FROM $9::uuid LIMIT 1
    ) d ON TRUE`, [principal.sessionId, principal.careActorId, principal.integrationId, selection.propertyId,
    null, 1, selection.tenantCompanyId, selection.buildingId, selection.spaceId, requestId, bastId]);
  const row = result.rows[0];
  if (!row?.authenticated) throw workspaceUnauthorized();
  if (!row.id) throw new AppError({ code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,
    statusCode: 404, message: 'Care workspace resource not found.' });
  return asDownload(row);
}
