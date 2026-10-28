import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { resolveBuildingCareAuthority } from '../handyman-care-authority';
import { createEvidenceStorage, evidenceStorageKey } from '../evidence/storage';
import { computeEvidenceSha256 } from '../evidence/evidence-integrity';
import { applyRetentionToEvidence } from '../evidence-retention-policies/evidence-retention-application.service';
import { handymanEvidenceQcRepository, type HandymanEvidenceMediaKind } from '../handyman-evidence-qc';
import { openHandymanServiceWarrantyClaim, submitHandymanServiceWarrantyClaim } from '../handyman-service-warranty-claims/handyman-service-warranty-claim.service';
import { parseClaimCertificatePin } from '../handyman-service-warranty-claims/handyman-warranty-claim-assessment.service';

/** A session is always supplied by authenticationMiddleware, never by the body. */
export type ComplaintActor = { userId: string; sessionId: string };
type Db = Pick<PoolClient, 'query'>;
type CareScope = { clientId: string; buildingId: string };
type ComplaintRow = {
  id: string; complaint_number: string; client_id: string; building_id: string;
  handyman_request_id: string; tenant_company_id: string; space_id: string | null;
  reported_certificate_id: string | null; reported_item_line_id: string | null;
  channel: string; channel_reference: string | null; reported_reporter_name: string;
  reported_reporter_contact: string | null; reported_reporter_pic_id: string | null;
  tenant_description: string; internal_care_notes: string | null;
  complaint_date_text: string; occurrence_date_text: string | null;
  recorded_by_user_id: string; idempotency_key: string; command_sha256: string;
  created_at: Date; claim_id: string | null; claim_status: string | null;
  evidence_record_id: string | null; claim_certificate_id: string | null; claim_item_line_id: string | null;
  claim_coverage_kind: string | null; claim_manifest_version: number | null;
  claim_source_sha256: string | null; claim_pdf_sha256: string | null; reporter_confirmed_user_id: string | null;
  reporter_confirmed_pic_id: string | null; reporter_confirmed_at: Date | null;
  assessment_id: string | null; assessment_result: string | null; assessment_revision: number | null;
  assessment_reason: string | null; assessor_id: string | null; assessed_at: Date | null;
};
type EvidenceRow = {
  id: string; evidence_type: HandymanEvidenceMediaKind; original_file_name: string;
  mime_type: string; file_size: string | number; content_sha256: string;
  file_reference: string; submitted_by_user_id: string; status: string; retention_state: string;
  created_at: Date; assessment_evidence_record_id: string | null;
};
const conflict = (message: string) => new AppError({ code: ERROR_CODES.CONFLICT, statusCode: 409, message });
const idempotencyConflict = () => new AppError({ code: ERROR_CODES.IDEMPOTENCY_CONFLICT, statusCode: 409,
  message: 'The idempotency key was already used for different complaint facts.' });
const digest = (input: unknown) => createHash('sha256').update(stableJson(input)).digest('hex');
const iso = (value: Date | null) => value ? value.toISOString() : null;
function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) throw AppError.validation(`A valid ${name} is required.`);
  return value.trim().toLowerCase();
}
function optionalUuid(value: unknown, name: string): string | null {
  return value === null || value === undefined ? null : uuid(value, name);
}
function text(value: unknown, name: string, max: number, optional = false): string | null {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    throw AppError.validation(`${name} must be non-empty text of at most ${max} characters.`);
  return value.trim();
}
function day(value: unknown, name: string, optional = false): string | null {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw AppError.validation(`${name} must be an ISO calendar date.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (value.startsWith('0000-') || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== value)
    throw AppError.validation(`${name} must be a valid calendar date.`);
  return value;
}
function bodyObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw AppError.validation('A JSON object is required.');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(k => !allowed.includes(k))) throw AppError.validation('Unexpected complaint field. Actor and scope are server-derived.');
  return body;
}
const keyOf = (v: unknown) => text(v, 'idempotencyKey', 128)!;

async function careScope(actor: ComplaintActor, buildingInput: string): Promise<CareScope> {
  const buildingId = uuid(buildingInput, 'buildingId');
  const authority = await resolveBuildingCareAuthority({ actorUserId: actor.userId, buildingId });
  return { clientId: authority.scope.clientId, buildingId };
}
/** Hold the same active role/assignment lineage through each write, including
 * against concurrent revocation after the outside-the-transaction preflight. */
async function lockCareAuthority(tx: PoolClient, scope: CareScope, actor: ComplaintActor): Promise<void> {
  const held = await tx.query(`SELECT u.id FROM users u
    JOIN user_role_assignments ura ON ura.user_id=u.id AND ura.status='ACTIVE'
    JOIN roles r ON r.id=ura.role_id AND r.status='ACTIVE'
    JOIN role_permission_assignments rpa ON rpa.role_id=r.id AND rpa.status='ACTIVE'
    JOIN permissions p ON p.id=rpa.permission_id AND p.status='ACTIVE' AND p.code='handyman.care.building'
    JOIN user_building_assignments a ON a.user_id=u.id AND a.building_id=$2 AND a.status='ACTIVE'
    JOIN buildings b ON b.id=a.building_id AND b.status='ACTIVE'
    JOIN properties pr ON pr.id=b.property_id AND pr.client_id=$3
    WHERE u.id=$1 AND u.status='ACTIVE' FOR SHARE OF u,ura,r,rpa,p,a,b,pr`,
    [actor.userId,scope.buildingId,scope.clientId]);
  if (!held.rowCount) throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,
    message:'Active Care authority for the exact Building is required.'});
}
const complaintSelect = `SELECT c.*, c.complaint_date::text AS complaint_date_text,
  c.occurrence_date::text AS occurrence_date_text, l.claim_id, l.evidence_record_id, cl.status AS claim_status,
  cb.certificate_id AS claim_certificate_id, cb.item_line_id AS claim_item_line_id, cb.coverage_kind AS claim_coverage_kind,
  cb.certificate_manifest_version AS claim_manifest_version, cb.certificate_source_sha256 AS claim_source_sha256,
  cb.certificate_pdf_sha256 AS claim_pdf_sha256, rc.user_id AS reporter_confirmed_user_id, rc.tenant_pic_id AS reporter_confirmed_pic_id, rc.confirmed_at AS reporter_confirmed_at,
  a.id AS assessment_id, a.result AS assessment_result, a.revision AS assessment_revision,
  a.reason AS assessment_reason, a.reviewer_user_id AS assessor_id, a.assessed_at
  FROM handyman_warranty_complaints c
  LEFT JOIN handyman_warranty_complaint_claim_links l ON l.complaint_id=c.id
  LEFT JOIN handyman_service_warranty_claims cl ON cl.id=l.claim_id
  LEFT JOIN handyman_warranty_claim_bindings cb ON cb.claim_id=l.claim_id
  LEFT JOIN handyman_warranty_complaint_reporter_confirmations rc ON rc.complaint_id=c.id
  LEFT JOIN LATERAL (SELECT * FROM handyman_warranty_claim_assessments aa WHERE aa.claim_id=l.claim_id
    ORDER BY aa.revision DESC LIMIT 1) a ON TRUE`;
async function loadComplaint(db: Db, scope: CareScope, complaintId: string, lock = false): Promise<ComplaintRow> {
  const result = await db.query<ComplaintRow>(`${complaintSelect} WHERE c.id=$1 AND c.client_id=$2 AND c.building_id=$3${lock ? ' FOR UPDATE OF c' : ''}`,
    [complaintId, scope.clientId, scope.buildingId]);
  if (!result.rows[0]) throw AppError.notFound('Warranty complaint not found.');
  return result.rows[0];
}
function statusOf(row: ComplaintRow): string {
  if (!row.claim_id) return 'PENDING_VERIFICATION';
  if (row.claim_status === 'CLAIM_APPROVED') return 'APPROVED';
  if (row.claim_status === 'CLAIM_REJECTED') return 'REJECTED';
  if (row.claim_status === 'CLAIM_WITHDRAWN') return 'WITHDRAWN';
  if (row.assessment_result === 'NEEDS_EVIDENCE') return 'NEEDS_EVIDENCE';
  if (row.assessment_result) return 'ASSESSED_AWAITING_DECISION';
  return 'PENDING_ASSESSMENT';
}
function statusView(row: ComplaintRow) {
  return { complaintId: row.id, complaintNumber: row.complaint_number, status: statusOf(row),
    claimId: row.claim_id, claimStatus: row.claim_status,
    certificateBinding: row.claim_certificate_id ? { certificateId:row.claim_certificate_id,
      itemLineId:row.claim_item_line_id,coverageKind:row.claim_coverage_kind,
      certificateManifestVersion:row.claim_manifest_version,certificateSourceSha256:row.claim_source_sha256,
      certificatePdfSha256:row.claim_pdf_sha256 } : null,
    assessment: row.assessment_id ? { id: row.assessment_id, revision: row.assessment_revision,
      result: row.assessment_result, reason: row.assessment_reason, reviewerUserId: row.assessor_id,
      assessedAt: iso(row.assessed_at) } : null };
}
function reporterView(row: ComplaintRow) {
  return { name: row.reported_reporter_name, contact: row.reported_reporter_contact,
    reportedTenantPicId: row.reported_reporter_pic_id,
    identityStatus: row.reporter_confirmed_user_id ? 'SELF_CONFIRMED' : 'REPORTED_ONLY',
    confirmedUserId: row.reporter_confirmed_user_id, confirmedTenantPicId: row.reporter_confirmed_pic_id,
    confirmedAt: iso(row.reporter_confirmed_at) };
}
function evidenceView(e: EvidenceRow) {
  return { id: e.id, kind: e.evidence_type, fileName: e.original_file_name, mimeType: e.mime_type,
    byteSize: Number(e.file_size), sha256: e.content_sha256, uploadedByUserId: e.submitted_by_user_id,
    status: e.status, retentionState: e.retention_state, uploadedAt: iso(e.created_at),
    assessmentEvidenceRecordId: e.assessment_evidence_record_id };
}
const evidenceSelect = `SELECT e.id,e.evidence_type,e.original_file_name,e.mime_type,e.file_size,
  e.content_sha256,e.file_reference,e.submitted_by_user_id,e.status,e.retention_state,ce.created_at,
  b.evidence_record_id AS assessment_evidence_record_id
  FROM handyman_warranty_complaint_evidence ce JOIN evidence_submissions e ON e.id=ce.evidence_submission_id
  LEFT JOIN handyman_warranty_complaint_evidence_bridges b ON b.evidence_submission_id=e.id`;
async function listEvidence(db: Db, complaintId: string): Promise<EvidenceRow[]> {
  return (await db.query<EvidenceRow>(`${evidenceSelect} WHERE ce.complaint_id=$1 ORDER BY ce.created_at,e.id`, [complaintId])).rows;
}
async function event(tx: PoolClient, complaintId: string, eventType: string, actor: ComplaintActor, referenceId: string | null = null) {
  await tx.query(`INSERT INTO handyman_warranty_complaint_events(id,complaint_id,event_type,actor_user_id,session_id,reference_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(),complaintId,eventType,actor.userId,actor.sessionId,referenceId]);
}

/** Create is idempotent and derives Client, tenant and unit exclusively from the exact request. */
export async function createComplaint(actor: ComplaintActor, buildingId: string, input: unknown) {
  const scope = await careScope(actor, buildingId);
  const b = bodyObject(input, ['requestId','reportedCertificateId','reportedItemLineId','channel','channelReference',
    'reportedReporterName','reportedReporterContact','reportedReporterPicId','tenantDescription','internalCareNotes',
    'complaintDate','occurrenceDate','idempotencyKey']);
  const data = { requestId: uuid(b.requestId,'requestId'), reportedCertificateId: optionalUuid(b.reportedCertificateId,'reportedCertificateId'),
    reportedItemLineId: optionalUuid(b.reportedItemLineId,'reportedItemLineId'),
    channel: b.channel, channelReference: text(b.channelReference,'channelReference',200,true),
    reportedReporterName: text(b.reportedReporterName,'reportedReporterName',200)!,
    reportedReporterContact: text(b.reportedReporterContact,'reportedReporterContact',200,true),
    reportedReporterPicId: optionalUuid(b.reportedReporterPicId,'reportedReporterPicId'),
    tenantDescription: text(b.tenantDescription,'tenantDescription',2000)!,
    internalCareNotes: text(b.internalCareNotes,'internalCareNotes',4000,true),
    complaintDate: day(b.complaintDate,'complaintDate')!, occurrenceDate: day(b.occurrenceDate,'occurrenceDate',true) };
  const key = keyOf(b.idempotencyKey);
  if (!['WHATSAPP','PHONE','EMAIL','DIRECT'].includes(String(data.channel))) throw AppError.validation('Invalid complaint channel.');
  if (data.reportedItemLineId && !data.reportedCertificateId) throw AppError.validation('An item reference requires its certificate.');
  if (data.occurrenceDate && data.occurrenceDate > data.complaintDate) throw AppError.validation('occurrenceDate cannot follow complaintDate.');
  const fingerprint = digest({ ...data, clientId:scope.clientId, buildingId:scope.buildingId });
  try {
    const result = await withTransaction(async tx => {
      await lockCareAuthority(tx,scope,actor);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`warranty-complaint:create:${actor.userId}:${key}`]);
      const existing = (await tx.query<{id:string;command_sha256:string}>(
        'SELECT id,command_sha256 FROM handyman_warranty_complaints WHERE recorded_by_user_id=$1 AND idempotency_key=$2', [actor.userId,key])).rows[0];
      if (existing) {
        if (existing.command_sha256 !== fingerprint) throw idempotencyConflict();
        return { id:existing.id, replayed:true };
      }
      const request = (await tx.query<{tenant_company_id:string;space_id:string | null}>(`SELECT tenant_company_id,space_id
        FROM handyman_service_requests WHERE id=$1 AND client_id=$2 AND building_id=$3 FOR SHARE`,
        [data.requestId,scope.clientId,scope.buildingId])).rows[0];
      if (!request) throw AppError.notFound('Handyman request not found.');
      if (data.reportedReporterPicId) {
        const pic = await tx.query('SELECT id FROM tenant_pics WHERE id=$1 AND tenant_company_id=$2 AND status=\'ACTIVE\'',
          [data.reportedReporterPicId,request.tenant_company_id]);
        if (!pic.rowCount) throw AppError.badRequest('The reported PIC is not active in this request tenant.');
      }
      if (data.reportedCertificateId) {
        const cert = await tx.query(`SELECT id FROM handyman_warranty_certificates d WHERE d.id=$1 AND d.client_id=$2 AND d.building_id=$3
          AND d.request_id=$4 AND d.tenant_company_id=$5 AND ($6::uuid IS NULL OR EXISTS
            (SELECT 1 FROM jsonb_array_elements(d.source_snapshot->'items') item WHERE item->>'rootLineId'=$6::text))`,
        [data.reportedCertificateId,scope.clientId,scope.buildingId,data.requestId,request.tenant_company_id,data.reportedItemLineId]);
        if (!cert.rowCount) throw AppError.badRequest('The reported certificate or item does not belong to this request.');
      }
      const complaintId = randomUUID();
      await tx.query(`INSERT INTO handyman_warranty_complaints
        (id,client_id,building_id,handyman_request_id,tenant_company_id,space_id,reported_certificate_id,reported_item_line_id,
         channel,channel_reference,reported_reporter_name,reported_reporter_contact,reported_reporter_pic_id,
         tenant_description,internal_care_notes,complaint_date,occurrence_date,recorded_by_user_id,idempotency_key,command_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::date,$17::date,$18,$19,$20)`,
      [complaintId,scope.clientId,scope.buildingId,data.requestId,request.tenant_company_id,request.space_id,
        data.reportedCertificateId,data.reportedItemLineId,data.channel,data.channelReference,data.reportedReporterName,
        data.reportedReporterContact,data.reportedReporterPicId,data.tenantDescription,data.internalCareNotes,
        data.complaintDate,data.occurrenceDate,actor.userId,key,fingerprint]);
      await event(tx,complaintId,'REGISTERED',actor);
      return {id:complaintId,replayed:false};
    });
    const row = await loadComplaint(getPool(),scope,result.id);
    return { ...statusView(row), replayed:result.replayed };
  } catch (error) {
    if ((error as {code?:string}).code === '23505') throw conflict('This channel reference has already been registered in the Building.');
    throw error;
  }
}

export async function listComplaints(actor: ComplaintActor, buildingId: string, requestId?: string) {
  const scope = await careScope(actor,buildingId);
  const request = requestId ? uuid(requestId,'requestId') : null;
  const rows = (await getPool().query<ComplaintRow>(`${complaintSelect} WHERE c.client_id=$1 AND c.building_id=$2
    AND ($3::uuid IS NULL OR c.handyman_request_id=$3) ORDER BY c.created_at DESC,c.id DESC LIMIT 100`,
    [scope.clientId,scope.buildingId,request])).rows;
  return rows.map(r => ({...statusView(r),requestId:r.handyman_request_id,channel:r.channel,
    complaintDate:r.complaint_date_text,recordedAt:iso(r.created_at)}));
}
export async function getComplaintStatus(actor: ComplaintActor, buildingId: string, complaintInput: string) {
  const scope = await careScope(actor,buildingId);
  return statusView(await loadComplaint(getPool(),scope,uuid(complaintInput,'complaintId')));
}
export async function getComplaintDetail(actor: ComplaintActor, buildingId: string, complaintInput: string) {
  const scope = await careScope(actor,buildingId), complaintId = uuid(complaintInput,'complaintId');
  const row = await loadComplaint(getPool(),scope,complaintId);
  const evidence = await listEvidence(getPool(),complaintId);
  const events = (await getPool().query<{event_type:string;actor_user_id:string;reference_id:string | null;occurred_at:Date}>(
    `SELECT event_type,actor_user_id,reference_id,occurred_at FROM handyman_warranty_complaint_events
     WHERE complaint_id=$1 ORDER BY occurred_at,id`,[complaintId])).rows;
  const assessmentHistory = row.claim_id ? (await getPool().query<{id:string;revision:number;result:string;reason:string;reviewer_user_id:string;assessed_at:Date}>(
    `SELECT id,revision,result,reason,reviewer_user_id,assessed_at FROM handyman_warranty_claim_assessments WHERE claim_id=$1 ORDER BY revision`, [row.claim_id])).rows : [];
  return { ...statusView(row), clientId:row.client_id,buildingId:row.building_id,requestId:row.handyman_request_id,
    tenantCompanyId:row.tenant_company_id,spaceId:row.space_id,reportedCertificateId:row.reported_certificate_id,
    reportedItemLineId:row.reported_item_line_id,channel:row.channel,channelReference:row.channel_reference,
    reporter:reporterView(row),tenantDescription:row.tenant_description,internalCareNotes:row.internal_care_notes,
    complaintDate:row.complaint_date_text,occurrenceDate:row.occurrence_date_text,recordedByUserId:row.recorded_by_user_id,
    recordedAt:iso(row.created_at),evidence:evidence.map(evidenceView),
    events:events.map(e=>({type:e.event_type,actorUserId:e.actor_user_id,referenceId:e.reference_id,occurredAt:iso(e.occurred_at)})),
    assessmentHistory:assessmentHistory.map(a=>({id:a.id,revision:a.revision,result:a.result,reason:a.reason,
      reviewerUserId:a.reviewer_user_id,assessedAt:iso(a.assessed_at)})) };
}

/** Preauthorize before multer allocates any file buffer; the write rechecks again. */
export async function authorizeComplaintUpload(actor: ComplaintActor, buildingId: string, complaintInput: string): Promise<void> {
  const scope = await careScope(actor,buildingId);
  await loadComplaint(getPool(),scope,uuid(complaintInput,'complaintId'));
}
function fileKind(mime: string, bytes: Buffer): HandymanEvidenceMediaKind {
  let valid = false, kind: HandymanEvidenceMediaKind = 'PHOTO';
  if (mime === 'image/jpeg') valid = bytes.length >= 3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff;
  else if (mime === 'image/png') valid = bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
  else if (mime === 'image/webp') valid = bytes.length >= 12 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP';
  else if (mime === 'application/pdf') { kind='DOCUMENT'; valid=bytes.length>=5 && bytes.toString('ascii',0,5)==='%PDF-'; }
  else if (mime === 'video/mp4' || mime === 'video/quicktime') { kind='VIDEO'; valid=bytes.length>=12 && bytes.toString('ascii',4,8)==='ftyp'; }
  if (!valid) throw AppError.validation('Evidence bytes must match a supported photo, PDF or video MIME type.');
  return kind;
}
async function verifiedBytes(e: EvidenceRow): Promise<Buffer> {
  if (e.status !== 'ACTIVE' || e.retention_state === 'PURGED' || e.file_reference !== evidenceStorageKey(e.id))
    throw conflict('Complaint evidence is unavailable or no longer active.');
  try {
    const stored = await createEvidenceStorage().get(e.file_reference);
    if (stored.size !== Number(e.file_size) || stored.buffer.length !== Number(e.file_size) ||
      computeEvidenceSha256(stored.buffer) !== e.content_sha256) throw new Error('digest mismatch');
    return stored.buffer;
  } catch {
    throw conflict('Complaint evidence bytes are missing or do not match their recorded digest.');
  }
}

/**
 * The adapter creates only a DEFECT record sourced from these immutable complaint
 * files. The event actor is the real Care staff member importing the files; the
 * original uploader remains on each evidence submission and bridge. No Crew
 * Lead, field-session, tenant consent or assessment is invented.
 */
async function makeEvidenceRecord(tx: PoolClient, row: ComplaintRow, scopeId: string, actor: ComplaintActor, files: EvidenceRow[]) {
  if (!files.length) throw conflict('At least one active complaint evidence file is required.');
  await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE',[scopeId]);
  for (const file of files) await verifiedBytes(file);
  const record = await handymanEvidenceQcRepository.createEvidenceRecord(tx, { clientId:row.client_id,
    executionScopeId:scopeId,sessionId:null,stage:'DEFECT',description:`Warranty complaint ${row.complaint_number}` });
  const base = `warranty-complaint:${row.id}:${record.id}`;
  await handymanEvidenceQcRepository.appendEvidenceEvent(tx,{recordId:record.id,clientId:row.client_id,
    eventType:'CREATE',idempotencyKey:`${base}:create`,actorUserId:actor.userId});
  const bridges: Array<{submissionId:string;fileId:string}> = [];
  for (const file of files) {
    const copied = await handymanEvidenceQcRepository.appendEvidenceFile(tx,{recordId:record.id,mediaKind:file.evidence_type,
      storageKey:file.file_reference,contentType:file.mime_type,byteSize:Number(file.file_size),
      sha256Digest:file.content_sha256,captureTime:null});
    await handymanEvidenceQcRepository.appendEvidenceEvent(tx,{recordId:record.id,clientId:row.client_id,
      eventType:'FILE_ADD',idempotencyKey:`${base}:${file.id}`,actorUserId:actor.userId});
    bridges.push({submissionId:file.id,fileId:copied.id});
  }
  await handymanEvidenceQcRepository.appendEvidenceEvent(tx,{recordId:record.id,clientId:row.client_id,
    eventType:'FINALIZE',idempotencyKey:`${base}:finalize`,actorUserId:actor.userId});
  return {recordId:record.id,bridges};
}
async function insertBridges(tx: PoolClient, complaintId: string, recordId: string,
  bridges: Array<{submissionId:string;fileId:string}>, actor: ComplaintActor) {
  for (const b of bridges) await tx.query(`INSERT INTO handyman_warranty_complaint_evidence_bridges
    (complaint_id,evidence_submission_id,evidence_record_id,evidence_file_id,bridged_by_user_id) VALUES($1,$2,$3,$4,$5)`,
  [complaintId,b.submissionId,recordId,b.fileId,actor.userId]);
}

export async function uploadComplaintEvidence(actor: ComplaintActor, buildingId: string, complaintInput: string,
  input: unknown, file: Express.Multer.File) {
  const scope = await careScope(actor,buildingId), complaintId=uuid(complaintInput,'complaintId');
  const b = bodyObject(input,['idempotencyKey']), key=keyOf(b.idempotencyKey);
  const bytes = file.buffer;
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 52_428_800) throw AppError.validation('Non-empty evidence up to 50 MB is required.');
  const mime = String(file.mimetype ?? '').toLowerCase(), kind=fileKind(mime,bytes);
  const filename = text(basename(String(file.originalname ?? '').replace(/\\/g,'/')),'fileName',255)!;
  const sha = computeEvidenceSha256(bytes);
  const fingerprint = digest({sha,filename,mime,kind,uploadedByUserId:actor.userId});
  const storage = createEvidenceStorage(); let writtenKey: string | null = null;
  let outcome: {id:string;replayed:boolean};
  try {
    outcome = await withTransaction(async tx => {
      await lockCareAuthority(tx,scope,actor);
      const complaint=await loadComplaint(tx,scope,complaintId,true);
      const prior=(await tx.query<{evidence_submission_id:string;command_sha256:string}>(`SELECT evidence_submission_id,command_sha256
        FROM handyman_warranty_complaint_evidence WHERE complaint_id=$1 AND idempotency_key=$2`,[complaintId,key])).rows[0];
      if (prior) {
        if (prior.command_sha256!==fingerprint) throw idempotencyConflict();
        return {id:prior.evidence_submission_id,replayed:true};
      }
      // A joined status observed before waiting on the complaint lock may be
      // stale. Re-read the link in a new statement *after* acquiring it.
      const linked=(await tx.query<{claim_id:string;execution_scope_id:string}>(`SELECT l.claim_id,c.execution_scope_id
        FROM handyman_warranty_complaint_claim_links l JOIN handyman_service_warranty_claims c ON c.id=l.claim_id
        WHERE l.complaint_id=$1`,[complaintId])).rows[0];
      if (linked) {
        // Assessment and decision use the same scope lock. Serialize before
        // checking reviewer history so an in-flight reviewer cannot race
        // into the uploader role after their assessment has committed.
        await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE',[linked.execution_scope_id]);
        const involved=(await tx.query<{involved:boolean}>(`SELECT EXISTS
          (SELECT 1 FROM handyman_warranty_claim_assessments WHERE claim_id=$1 AND reviewer_user_id=$2)
          OR EXISTS (SELECT 1 FROM handyman_service_warranty_claims WHERE id=$1 AND decided_by_user_id=$2) AS involved`,
          [linked.claim_id,actor.userId])).rows[0].involved;
        if (involved) throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,
          message:'A claim assessor or decider cannot become a complaint evidence uploader.'});
      }
      const count=(await tx.query<{n:number}>('SELECT count(*)::int AS n FROM handyman_warranty_complaint_evidence WHERE complaint_id=$1',[complaintId])).rows[0].n;
      if (count>=100) throw conflict('A complaint may contain at most 100 evidence files.');
      const id=randomUUID(), storageKey=evidenceStorageKey(id);
      writtenKey=storageKey;
      await storage.put(storageKey,{buffer:bytes,mimeType:mime});
      const stored=await storage.get(storageKey);
      if (stored.size!==bytes.length || computeEvidenceSha256(stored.buffer)!==sha) throw conflict('Evidence storage verification failed.');
      await tx.query(`INSERT INTO evidence_submissions(id,client_id,execution_type,execution_id,evidence_type,file_reference,
        original_file_name,mime_type,file_size,captured_at,submitted_by_user_id,content_sha256,content_hashed_at,hash_algorithm)
        VALUES($1,$2,'HANDYMAN_WARRANTY_COMPLAINT',$3,$4,$5,$6,$7,$8,NULL,$9,$10,NOW(),'SHA-256')`,
        [id,scope.clientId,complaintId,kind,storageKey,filename,mime,bytes.length,actor.userId,sha]);
      await tx.query(`INSERT INTO handyman_warranty_complaint_evidence
        (complaint_id,evidence_submission_id,uploaded_by_user_id,idempotency_key,command_sha256) VALUES($1,$2,$3,$4,$5)`,
        [complaintId,id,actor.userId,key,fingerprint]);
      if (linked) {
        const uploaded=(await listEvidence(tx,complaintId)).find(e=>e.id===id);
        if (!uploaded) throw conflict('Complaint evidence is unavailable.');
        const record=await makeEvidenceRecord(tx,complaint,linked.execution_scope_id,actor,[uploaded]);
        await insertBridges(tx,complaintId,record.recordId,record.bridges,actor);
      }
      await event(tx,complaintId,'EVIDENCE_ADDED',actor,id);
      return {id,replayed:false};
    });
  } catch (error) {
    if (writtenKey) await storage.remove(writtenKey).catch(()=>undefined);
    throw error;
  }
  // The shared retention policy is applied after commit, as with payment proof.
  // A retry re-applies if a post-commit policy operation failed.
  await applyRetentionToEvidence(outcome.id,actor.userId);
  const evidence=(await listEvidence(getPool(),complaintId)).find(e=>e.id===outcome.id);
  if (!evidence) throw AppError.notFound('Complaint evidence not found.');
  return { evidence:evidenceView(evidence),replayed:outcome.replayed };
}

/** Atomic adapter into the existing OPEN/SUBMIT path; it never assesses or grants coverage. */
export async function submitComplaintClaim(actor: ComplaintActor, buildingId: string, complaintInput: string, input: unknown) {
  const scope=await careScope(actor,buildingId), complaintId=uuid(complaintInput,'complaintId');
  const b=bodyObject(input,['certificateId','certificateSourceSha256','certificatePdfSha256','certificateManifestVersion','itemLineId','coverageKind','idempotencyKey']);
  const pin=parseClaimCertificatePin(b), key=keyOf(b.idempotencyKey), fingerprint=digest({pin,actorUserId:actor.userId});
  const outcome=await withTransaction(async tx=>{
    await lockCareAuthority(tx,scope,actor);
    const complaint=await loadComplaint(tx,scope,complaintId,true);
    const prior=(await tx.query<{claim_id:string;evidence_record_id:string;idempotency_key:string;command_sha256:string}>(
      'SELECT claim_id,evidence_record_id,idempotency_key,command_sha256 FROM handyman_warranty_complaint_claim_links WHERE complaint_id=$1',[complaintId])).rows[0];
    if (prior) {
      if (prior.idempotency_key!==key || prior.command_sha256!==fingerprint) throw idempotencyConflict();
      return {claimId:prior.claim_id,evidenceRecordId:prior.evidence_record_id,replayed:true};
    }
    if ((complaint.reported_certificate_id && complaint.reported_certificate_id!==pin.certificateId) ||
        (complaint.reported_item_line_id && complaint.reported_item_line_id!==pin.itemLineId))
      throw conflict('The selected certificate or item differs from the reported reference.');
    const cert=(await tx.query<{warranty_id:string;execution_scope_id:string}>(`SELECT d.warranty_id,d.execution_scope_id
      FROM handyman_warranty_certificates d JOIN handyman_execution_scopes s ON s.id=d.execution_scope_id
      WHERE d.id=$1 AND d.client_id=$2 AND d.building_id=$3 AND d.request_id=$4 AND d.tenant_company_id=$5
        AND s.space_id IS NOT DISTINCT FROM $6::uuid`,
      [pin.certificateId,scope.clientId,scope.buildingId,complaint.handyman_request_id,complaint.tenant_company_id,complaint.space_id])).rows[0];
    if (!cert) throw conflict('The certificate does not belong to this exact request, tenant and unit.');
    const files=(await listEvidence(tx,complaintId)).filter(e=>e.status==='ACTIVE' && e.retention_state!=='PURGED');
    const record=await makeEvidenceRecord(tx,complaint,cert.execution_scope_id,actor,files);
    const open=await openHandymanServiceWarrantyClaim(actor.userId,{...pin,warrantyId:cert.warranty_id,
      claimNote:complaint.tenant_description,evidenceRecordId:record.recordId,idempotencyKey:`complaint:${complaintId}:open`},tx);
    const submitted=await submitHandymanServiceWarrantyClaim(actor.userId,{claimId:open.claim.id,
      evidenceRecordId:record.recordId,idempotencyKey:`complaint:${complaintId}:submit`},tx);
    await tx.query(`INSERT INTO handyman_warranty_complaint_claim_links
      (complaint_id,claim_id,evidence_record_id,submitted_by_user_id,idempotency_key,command_sha256) VALUES($1,$2,$3,$4,$5,$6)`,
      [complaintId,submitted.claim.id,record.recordId,actor.userId,key,fingerprint]);
    await insertBridges(tx,complaintId,record.recordId,record.bridges,actor);
    await event(tx,complaintId,'CLAIM_SUBMITTED',actor,submitted.claim.id);
    return {claimId:submitted.claim.id,evidenceRecordId:record.recordId,replayed:false};
  });
  const row=await loadComplaint(getPool(),scope,complaintId);
  return {...statusView(row),assessmentEvidenceRecordId:outcome.evidenceRecordId,replayed:outcome.replayed};
}

/** The actual tenant PIC may confirm only their own identity, never coverage or consent. */
export async function confirmComplaintReporter(actor: ComplaintActor, complaintInput: string, input: unknown) {
  const complaintId=uuid(complaintInput,'complaintId'), b=bodyObject(input,['iAmReporter','idempotencyKey']);
  if (b.iAmReporter!==true) throw AppError.validation('iAmReporter must be true.');
  const key=keyOf(b.idempotencyKey);
  return withTransaction(async tx=>{
    const row=(await tx.query<{id:string;pic_id:string}>(`SELECT c.id,p.id AS pic_id FROM handyman_warranty_complaints c
      JOIN tenant_pics p ON p.tenant_company_id=c.tenant_company_id AND p.user_id=$2 AND p.status='ACTIVE'
        AND (c.reported_reporter_pic_id IS NULL OR c.reported_reporter_pic_id=p.id)
      JOIN users u ON u.id=p.user_id AND u.status='ACTIVE'
      JOIN user_sessions s ON s.id=$3 AND s.user_id=u.id AND s.status='ACTIVE' AND s.expires_at>clock_timestamp()
      WHERE c.id=$1 FOR UPDATE OF c FOR SHARE OF p,u,s`,[complaintId,actor.userId,actor.sessionId])).rows[0];
    if (!row) throw AppError.notFound('Warranty complaint not found.');
    const linked=(await tx.query<{execution_scope_id:string}>(`SELECT c.execution_scope_id
      FROM handyman_warranty_complaint_claim_links l JOIN handyman_service_warranty_claims c ON c.id=l.claim_id
      WHERE l.complaint_id=$1`,[complaintId])).rows[0];
    if (linked) await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE',[linked.execution_scope_id]);
    const prior=(await tx.query<{user_id:string;idempotency_key:string}>(
      'SELECT user_id,idempotency_key FROM handyman_warranty_complaint_reporter_confirmations WHERE complaint_id=$1',[complaintId])).rows[0];
    if (prior) {
      if (prior.user_id!==actor.userId || prior.idempotency_key!==key) throw idempotencyConflict();
      return {complaintId,identityStatus:'SELF_CONFIRMED',replayed:true};
    }
    await tx.query(`INSERT INTO handyman_warranty_complaint_reporter_confirmations(complaint_id,tenant_pic_id,user_id,session_id,idempotency_key)
      VALUES($1,$2,$3,$4,$5)`,[complaintId,row.pic_id,actor.userId,actor.sessionId,key]);
    await event(tx,complaintId,'REPORTER_SELF_CONFIRMED',actor,row.pic_id);
    return {complaintId,identityStatus:'SELF_CONFIRMED',replayed:false};
  });
}

async function loadAssessorComplaint(actor: ComplaintActor, claimInput: string): Promise<ComplaintRow> {
  const claimId=uuid(claimInput,'claimId');
  const row=(await getPool().query<ComplaintRow>(`${complaintSelect}
    WHERE l.claim_id=$1 AND hm_warranty_claim_assessor_authorized(l.claim_id,$2)
      AND hm_warranty_complaint_assessor_independent(l.claim_id,$2)`,[claimId,actor.userId])).rows[0];
  if (!row) throw AppError.notFound('Claim complaint not found.');
  return row;
}
/** Only the independent assessor receives reported details; internal Care notes stay private. */
export async function getAssessorComplaint(actor: ComplaintActor, claimInput: string) {
  const row=await loadAssessorComplaint(actor,claimInput);
  const evidence=await listEvidence(getPool(),row.id);
  return {complaintId:row.id,complaintNumber:row.complaint_number,claimId:row.claim_id,
    requestId:row.handyman_request_id,tenantCompanyId:row.tenant_company_id,spaceId:row.space_id,
    reporter:reporterView(row),tenantDescription:row.tenant_description,channel:row.channel,
    complaintDate:row.complaint_date_text,occurrenceDate:row.occurrence_date_text,
    recordedByUserId:row.recorded_by_user_id,evidence:evidence.map(evidenceView)};
}
async function findComplaintEvidence(complaintId: string, evidenceInput: string): Promise<EvidenceRow> {
  const evidenceId=uuid(evidenceInput,'evidenceId');
  const evidence=(await listEvidence(getPool(),complaintId)).find(e=>e.id===evidenceId);
  if (!evidence) throw AppError.notFound('Complaint evidence not found.');
  return evidence;
}
export async function readCareComplaintEvidence(actor: ComplaintActor, buildingId: string, complaintInput: string, evidenceInput: string) {
  const scope=await careScope(actor,buildingId), complaintId=uuid(complaintInput,'complaintId');
  await loadComplaint(getPool(),scope,complaintId);
  const evidence=await findComplaintEvidence(complaintId,evidenceInput);
  return {buffer:await verifiedBytes(evidence),mimeType:evidence.mime_type,fileName:evidence.original_file_name};
}
export async function readAssessorComplaintEvidence(actor: ComplaintActor, claimInput: string, evidenceInput: string) {
  const complaint=await loadAssessorComplaint(actor,claimInput);
  const evidence=await findComplaintEvidence(complaint.id,evidenceInput);
  if (!evidence.assessment_evidence_record_id) throw AppError.notFound('Claim evidence not found.');
  return {buffer:await verifiedBytes(evidence),mimeType:evidence.mime_type,fileName:evidence.original_file_name};
}
