import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { careAuthorityDeniedError, resolveBuildingCareAuthority } from '../handyman-care-authority';
import { assertCurrentGuardedHandymanQcPass } from '../handyman-evidence-qc/handyman-qc-pass-gate';
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

/**
 * One Care-only projection of existing facts. A repeatable-read snapshot keeps
 * authorization, the complaint link and the downstream lineage consistent.
 * The QC pass gate may take its usual row locks and re-hash evidence, but this
 * endpoint never creates or changes any domain record.
 */
export async function getComplaintTracking(actor: ComplaintActor, buildingId: string, complaintInput: string) {
  const scope = await careScope(actor, buildingId), complaintId = uuid(complaintInput, 'complaintId');
  return withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const authorized = await tx.query(`SELECT 1 FROM buildings b
      JOIN properties p ON p.id=b.property_id JOIN clients c ON c.id=p.client_id
      WHERE b.id=$2 AND c.id=$3 AND b.status='ACTIVE' AND p.status='ACTIVE' AND c.status='ACTIVE'
        AND hm_warranty_complaint_care_authorized($1,$3,$2) FOR SHARE OF b,p,c`, [actor.userId, scope.buildingId, scope.clientId]);
    if (!authorized.rowCount) throw careAuthorityDeniedError();
    // Hold the exact Care grant and Building assignment against revocation
    // until the snapshot has been consumed, as for the existing writes.
    await lockCareAuthority(tx,scope,actor);
    const complaint = await loadComplaint(tx, scope, complaintId);
    // The complaint link, not the request or a user-supplied identifier, is
    // the only way to reach a claim. Fail closed on a historical broken link.
    const claim = complaint.claim_id ? (await tx.query<{
      id:string; execution_scope_id:string; decision_assessment_id:string|null;
      certificate_id:string; item_line_id:string; coverage_kind:string; certificate_current:boolean;
    }>(`SELECT cl.id,cl.execution_scope_id,cl.decision_assessment_id,b.certificate_id,b.item_line_id,b.coverage_kind,
          hm_warranty_certificate_is_current(d.id) AS certificate_current
        FROM handyman_warranty_complaint_claim_links l
        JOIN handyman_warranty_complaints c ON c.id=l.complaint_id
        JOIN handyman_service_warranty_claims cl ON cl.id=l.claim_id AND cl.client_id=c.client_id
        JOIN handyman_execution_scopes s ON s.id=cl.execution_scope_id AND s.client_id=c.client_id
          AND s.building_id=c.building_id AND s.handyman_request_id=c.handyman_request_id
          AND s.tenant_company_id=c.tenant_company_id AND s.space_id IS NOT DISTINCT FROM c.space_id
          AND s.scope_kind='ORIGINAL'
        JOIN handyman_warranty_claim_bindings b ON b.claim_id=cl.id
        JOIN handyman_warranty_certificates d ON d.id=b.certificate_id AND d.client_id=c.client_id
          AND d.building_id=c.building_id AND d.request_id=c.handyman_request_id
          AND d.tenant_company_id=c.tenant_company_id AND d.execution_scope_id=s.id
          AND d.warranty_id=cl.warranty_id AND d.bast_id=cl.bast_id
        WHERE c.id=$1 AND c.client_id=$2 AND c.building_id=$3`,
    [complaint.id, scope.clientId, scope.buildingId])).rows[0] : undefined;
    const view = statusView(complaint);
    const referenceStatus = !claim ? 'UNVERIFIED' : claim.certificate_current ? 'LINKED' : 'HISTORICAL';
    const rework = claim ? (await tx.query<{
      id:string; status:string; child_id:string|null; scope_current:boolean|null;
    }>(`SELECT r.id,r.status,s.id AS child_id,
          CASE WHEN s.id IS NOT NULL THEN hm_warranty_rework_scope_current(s.id) ELSE NULL END AS scope_current
        FROM handyman_service_warranty_reworks r
        LEFT JOIN handyman_warranty_rework_executions x ON x.rework_id=r.id AND x.claim_id=$1
          AND x.original_scope_id=$3 AND x.assessment_id=$4 AND x.certificate_id=$5
          AND x.item_line_id=$6 AND x.coverage_kind=$7 AND x.client_id=$2 AND x.building_id=$8
        LEFT JOIN handyman_execution_scopes s ON s.id=x.execution_scope_id AND s.scope_kind='WARRANTY_REWORK'
          AND s.warranty_rework_id=r.id AND s.client_id=$2 AND s.building_id=$8
          AND s.handyman_request_id=$9 AND s.tenant_company_id=$10 AND s.space_id IS NOT DISTINCT FROM $11::uuid
        WHERE r.claim_id=$1 AND r.client_id=$2 AND r.execution_scope_id=$3`,
    [claim.id, scope.clientId, claim.execution_scope_id, claim.decision_assessment_id, claim.certificate_id,
      claim.item_line_id, claim.coverage_kind, scope.buildingId, complaint.handyman_request_id,
      complaint.tenant_company_id, complaint.space_id])).rows[0] : undefined;
    const child = rework?.child_id ?? null;
    const lineage = !child ? 'UNVERIFIED' : rework?.scope_current ? 'BOUND' : 'HISTORICAL';

    type Appointment = {id:string; state:string; version:number; start_at:Date; end_at:Date; timezone:string;
      assignment_id:string|null; bound_lead_user_id:string|null; bound:boolean; consent_present:boolean; consent_id:string|null;
      tenant_user_id:string|null; accepted_at:Date|null; confirmed_by_user_id:string|null; confirmed_at:Date|null;
      created_by_user_id:string; created_at:Date};
    const appointmentRows = child ? (await tx.query<Appointment>(`SELECT a.id,a.state,a.version,a.start_at,a.end_at,a.timezone,
        v.assignment_id,v.lead_user_id AS bound_lead_user_id,(v.appointment_id IS NOT NULL) AS bound,co.id AS consent_id,co.tenant_user_id,co.accepted_at,
        EXISTS(SELECT 1 FROM handyman_warranty_rework_visit_consents recorded WHERE recorded.appointment_id=a.id) AS consent_present,
        a.confirmed_by_user_id,a.confirmed_at,a.created_by_user_id,a.created_at
      FROM handyman_visit_appointments a
      LEFT JOIN handyman_warranty_rework_visit_bindings v ON v.appointment_id=a.id AND v.rework_id=$2
        AND v.execution_scope_id=$1 AND v.claim_id=$3 AND v.assessment_id=$4 AND v.certificate_id=$5
        AND v.item_line_id=$6 AND v.client_id=$7 AND v.building_id=$8 AND a.warranty_rework_id=$2
        AND a.kind='EXECUTION' AND a.resource_type='CREW' AND a.resource_id=v.crew_id
      LEFT JOIN handyman_warranty_rework_visit_consents co ON co.appointment_id=a.id AND co.rework_id=$2
        AND co.execution_scope_id=$1 AND co.claim_id=$3 AND co.assessment_id=$4
        AND co.client_id=$7 AND co.building_id=$8 AND co.start_at=a.start_at AND co.end_at=a.end_at
        AND co.id::text=a.tenant_choice_evidence_ref AND co.accepted_at>=a.created_at
        AND (a.confirmed_at IS NULL OR co.accepted_at<=a.confirmed_at)
        AND co.tenant_pic_id=(SELECT tenant_pic_id FROM handyman_execution_scopes WHERE id=$1)
        AND EXISTS (SELECT 1 FROM user_sessions sess WHERE sess.id=co.tenant_session_id AND sess.user_id=co.tenant_user_id)
        AND EXISTS (SELECT 1 FROM tenant_pics pic WHERE pic.id=co.tenant_pic_id
          AND pic.tenant_company_id=$10 AND pic.user_id=co.tenant_user_id)
        AND ((a.state='TENANT_SELECTED' AND a.version=co.appointment_version+1)
          OR (a.state='CONFIRMED' AND a.version=co.appointment_version+2)
          OR (a.state='IN_PROGRESS' AND a.version=co.appointment_version+3)
          OR (a.state='COMPLETED' AND a.version=co.appointment_version+4)
          OR (a.state='CANCELLED' AND ((a.confirmed_at IS NULL AND a.version=co.appointment_version+2)
            OR (a.confirmed_at IS NOT NULL AND a.version IN (co.appointment_version+3,co.appointment_version+4)))))
      WHERE a.execution_scope_id=$1 AND a.client_id=$7 AND a.building_id=$8
        AND a.handyman_request_id=$9 AND a.tenant_company_id=$10
        AND (a.warranty_rework_id=$2 OR a.warranty_rework_id IS NULL)
      ORDER BY a.created_at DESC,a.id DESC`, [child,rework!.id,claim!.id,claim!.decision_assessment_id,
      claim!.certificate_id,claim!.item_line_id,scope.clientId,scope.buildingId,
      complaint.handyman_request_id,complaint.tenant_company_id])).rows : [];
    const appointments = appointmentRows.map(a => ({
      appointmentId:a.id, state:a.state, version:a.version, startAt:iso(a.start_at), endAt:iso(a.end_at), timezone:a.timezone,
      bindingStatus:a.bound ? lineage : 'UNVERIFIED',
      consentStatus:!a.bound ? 'UNVERIFIED' : a.consent_id ? 'RECORDED' :
        (a.consent_present || ['TENANT_SELECTED','CONFIRMED','IN_PROGRESS','COMPLETED'].includes(a.state)) ? 'UNVERIFIED' : 'NOT_RECORDED',
      consentedByUserId:a.consent_id ? a.tenant_user_id : null, consentedAt:a.consent_id ? iso(a.accepted_at) : null,
      confirmationStatus:!a.bound || (a.confirmed_at && !a.consent_id) ||
        (['CONFIRMED','IN_PROGRESS','COMPLETED'].includes(a.state) && (!a.consent_id || !a.confirmed_at)) ? 'UNVERIFIED' :
        a.confirmed_at ? (a.state === 'CANCELLED' ? 'CONFIRMED_BEFORE_CANCELLATION' : 'CONFIRMED') : 'NOT_CONFIRMED',
      confirmedByUserId:a.confirmed_at ? a.confirmed_by_user_id : null, confirmedAt:iso(a.confirmed_at),
      createdByUserId:a.created_by_user_id, createdAt:iso(a.created_at),
    }));
    type Dispatch = {id:string; appointment_id:string|null; assignment_id:string; status:string;
      released_by_user_id:string; released_at:Date; cancelled_by_user_id:string|null; cancelled_at:Date|null;
      confirmed_before_release:boolean|null};
    const dispatchRows = child ? (await tx.query<Dispatch>(`SELECT d.id,d.appointment_id,d.assignment_id,d.status,d.released_by_user_id,
      d.released_at,d.cancelled_by_user_id,d.cancelled_at,
      (SELECT a.confirmed_at<=d.released_at FROM handyman_visit_appointments a WHERE a.id=d.appointment_id) AS confirmed_before_release
      FROM handyman_dispatch_releases d WHERE d.execution_scope_id=$1 AND d.client_id=$2
      ORDER BY d.released_at DESC,d.id DESC`,[child,scope.clientId])).rows : [];
    const dispatches = dispatchRows.map(d => {
      const appointment=appointmentRows.find(a=>a.id===d.appointment_id);
      const bound=appointment?.bound && appointment.consent_id && d.confirmed_before_release &&
        appointment.assignment_id===d.assignment_id;
      return {dispatchId:d.id,appointmentId:d.appointment_id,status:d.status,bindingStatus:bound ? lineage : 'UNVERIFIED',
        releasedByUserId:d.released_by_user_id,releasedAt:iso(d.released_at),
        cancelledByUserId:d.cancelled_by_user_id,cancelledAt:iso(d.cancelled_at)};
    });
    type Session = {id:string;assignment_id:string;lead_user_id:string;status:string;checked_in_at:Date;
      started_work_at:Date|null;completed_at:Date|null;checked_out_at:Date|null;dispatch_id:string|null};
    const sessionRows = child ? (await tx.query<Session>(`SELECT s.id,s.assignment_id,s.lead_user_id,s.status,s.checked_in_at,
      s.started_work_at,s.completed_at,s.checked_out_at,
      (SELECT d.id FROM handyman_dispatch_releases d WHERE d.execution_scope_id=s.execution_scope_id
        AND d.client_id=s.client_id AND d.assignment_id=s.assignment_id AND d.released_at<=s.checked_in_at
        AND (d.cancelled_at IS NULL OR d.cancelled_at>=s.checked_in_at)
        ORDER BY d.released_at DESC,d.id DESC LIMIT 1) AS dispatch_id
      FROM handyman_work_sessions s WHERE s.execution_scope_id=$1 AND s.client_id=$2
      ORDER BY s.checked_in_at DESC,s.id DESC`,[child,scope.clientId])).rows : [];
    const sessions = sessionRows.map(s => {
      const dispatch=dispatchRows.find(d=>d.id===s.dispatch_id);
      const appointment=appointmentRows.find(a=>a.id===dispatch?.appointment_id);
      const bound=appointment?.bound_lead_user_id===s.lead_user_id ?
        dispatches.find(x=>x.dispatchId===s.dispatch_id)?.bindingStatus : undefined;
      return {sessionId:s.id,status:s.status,bindingStatus:bound || 'UNVERIFIED',leadUserId:s.lead_user_id,
        checkedInAt:iso(s.checked_in_at),startedWorkAt:iso(s.started_work_at),completedAt:iso(s.completed_at),checkedOutAt:iso(s.checked_out_at)};
    });
    const completion = child ? (await tx.query<{id:string;session_id:string|null;assignment_id:string;lead_user_id:string;
      completed_at:Date;session_matches:boolean;dispatch_id:string|null}>(`SELECT c.id,c.session_id,c.assignment_id,c.lead_user_id,c.completed_at,
        EXISTS (SELECT 1 FROM handyman_work_sessions s WHERE s.id=c.session_id AND s.execution_scope_id=c.execution_scope_id
          AND s.client_id=$3 AND s.assignment_id=c.assignment_id AND s.lead_user_id=c.lead_user_id AND s.completed_at<=c.completed_at
          AND s.status IN ('COMPLETED','CHECKED_OUT')) AS session_matches,
        (SELECT d.id FROM handyman_dispatch_releases d WHERE d.execution_scope_id=c.execution_scope_id AND d.client_id=$3
          AND d.assignment_id=c.assignment_id AND d.released_at<=c.completed_at
          AND (d.cancelled_at IS NULL OR d.cancelled_at>=c.completed_at)
          ORDER BY d.released_at DESC,d.id DESC LIMIT 1) AS dispatch_id
      FROM handyman_warranty_rework_completions c WHERE c.rework_id=$1 AND c.execution_scope_id=$2`,[rework!.id,child,scope.clientId])).rows[0] : undefined;
    const completionSession = completion?.session_matches ? sessions.find(s=>s.sessionId===completion.session_id) : undefined;
    const completionDispatch = completion?.session_id === null ? dispatchRows.find(d=>d.id===completion.dispatch_id) : undefined;
    const completionAppointment = appointmentRows.find(a=>a.id===completionDispatch?.appointment_id);
    const completionLineage = completionSession?.bindingStatus ??
      (completionDispatch && completionAppointment?.bound_lead_user_id===completion?.lead_user_id ?
        dispatches.find(d=>d.dispatchId===completionDispatch.id)?.bindingStatus : undefined) ?? 'UNVERIFIED';
    type Qc = {id:string;status:string;created_at:Date;updated_at:Date;bound:boolean;finish_outcome:string|null};
    const qcRows = child ? (await tx.query<Qc>(`SELECT q.id,q.status,q.created_at,q.updated_at,
        (b.qc_run_id IS NOT NULL AND c.completed_at<=q.created_at) AS bound,
        (SELECT e.metadata->>'outcome' FROM handyman_qc_run_events e
          WHERE e.run_id=q.id AND e.event_type='FINISH' ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1) AS finish_outcome
      FROM handyman_qc_runs q
      LEFT JOIN handyman_warranty_rework_qc_bindings b ON b.qc_run_id=q.id AND b.execution_scope_id=q.execution_scope_id
        AND b.completion_id=$3
      LEFT JOIN handyman_warranty_rework_completions c ON c.id=b.completion_id AND c.execution_scope_id=q.execution_scope_id
        AND c.rework_id=$2
      WHERE q.execution_scope_id=$1 AND q.client_id=$4 ORDER BY q.created_at DESC,q.id DESC`,
      [child,rework!.id,completion?.id ?? null,scope.clientId])).rows : [];
    const latestQc = qcRows[0];
    const qcLineage = latestQc?.bound ? completionLineage : 'UNVERIFIED';
    let qcVerification = 'UNVERIFIED';
    if (latestQc?.bound && qcLineage==='BOUND') {
      if (latestQc.status==='OPEN') qcVerification='PENDING';
      else if (latestQc.status==='FAILED' && latestQc.finish_outcome==='FAILED') qcVerification='RECORDED_FAILURE';
      else if (latestQc.status==='PASSED' && latestQc.finish_outcome==='PASSED') {
        try {
          // This is the same exact-child, latest-run and byte-verification gate
          // used by the existing rework execution read, not a new QC authority.
          await assertCurrentGuardedHandymanQcPass(tx,{id:child!,clientId:scope.clientId,buildingId:scope.buildingId},latestQc.id);
          qcVerification='CURRENT_GUARDED_PASS';
        } catch (error) {
          if (!(error instanceof AppError) || error.statusCode!==409) throw error;
        }
      }
    }
    type Event = {id:string;source:string;type:string;subject_id:string;actor_user_id:string|null;
      occurred_at_text:string;result:string|null};
    // Every timeline entry is either an existing append-only event or the
    // immutable assessment/completion record itself; no event is inferred from
    // a status change. Sort in PostgreSQL before formatting microseconds.
    const events = (await tx.query<Event>(`WITH timeline AS (
      SELECT e.id,'COMPLAINT'::text AS source,e.event_type AS type,e.complaint_id AS subject_id,e.actor_user_id,
        e.occurred_at,NULL::text AS result FROM handyman_warranty_complaint_events e
        JOIN handyman_warranty_complaints c ON c.id=e.complaint_id
        WHERE e.complaint_id=$1 AND c.client_id=$7 AND c.building_id=$8
      UNION ALL SELECT e.id,'CLAIM',e.event_type,e.claim_id,e.actor_user_id,e.occurred_at,NULL::text
        FROM handyman_service_warranty_claim_events e WHERE e.claim_id=$2 AND e.client_id=$7
      UNION ALL SELECT a.id,'ASSESSMENT','RECORDED',a.claim_id,a.reviewer_user_id,a.assessed_at,a.result
        FROM handyman_warranty_claim_assessments a WHERE a.claim_id=$2
      UNION ALL SELECT e.id,'REWORK',e.event_type,e.rework_id,e.actor_user_id,e.occurred_at,NULL::text
        FROM handyman_service_warranty_rework_events e WHERE e.rework_id=$3 AND e.claim_id=$2 AND e.client_id=$7
      UNION ALL SELECT o.id,'APPOINTMENT',o.event_type,o.entity_id,o.actor_user_id,o.occurred_at,NULL::text
        FROM operational_events o WHERE o.client_id=$7 AND o.building_id=$8 AND o.entity_type='HANDYMAN_VISIT_APPOINTMENT'
          AND o.entity_id=ANY($5::uuid[]) AND o.event_type IN ('HANDYMAN_REWORK_VISIT_PROPOSED',
            'HANDYMAN_REWORK_VISIT_TENANT_CONSENT','HANDYMAN_VISIT_CONFIRMED','HANDYMAN_REWORK_VISIT_CANCELLED')
      UNION ALL SELECT o.id,'DISPATCH',o.event_type,o.entity_id,o.actor_user_id,o.occurred_at,NULL::text
        FROM operational_events o WHERE o.client_id=$7 AND o.building_id=$8 AND o.entity_type='HANDYMAN_DISPATCH_RELEASE'
          AND o.entity_id=ANY($6::uuid[]) AND o.event_type IN ('HANDYMAN_DISPATCH_RELEASED','HANDYMAN_DISPATCH_CANCELLED')
      UNION ALL SELECT e.id,'WORK_SESSION',e.event_type,e.session_id,e.actor_user_id,e.occurred_at,NULL::text
        FROM handyman_work_session_events e JOIN handyman_work_sessions s ON s.id=e.session_id
          AND s.execution_scope_id=e.execution_scope_id AND s.client_id=e.client_id
        WHERE s.execution_scope_id=$4 AND s.client_id=$7
      UNION ALL SELECT c.id,'COMPLETION','RECORDED',c.rework_id,c.lead_user_id,c.completed_at,NULL::text
        FROM handyman_warranty_rework_completions c WHERE c.rework_id=$3 AND c.execution_scope_id=$4
      UNION ALL SELECT e.id,'QC',e.event_type,e.run_id,e.actor_user_id,e.occurred_at,e.metadata->>'outcome'
        FROM handyman_qc_run_events e JOIN handyman_qc_runs q ON q.id=e.run_id AND q.client_id=e.client_id
        WHERE q.execution_scope_id=$4 AND q.client_id=$7
      ) SELECT id,source,type,subject_id,actor_user_id,result,
        to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_text
        FROM timeline ORDER BY occurred_at,source,id`,
    [complaint.id,claim?.id ?? null,rework?.id ?? null,child,appointmentRows.map(a=>a.id),
      dispatchRows.map(d=>d.id),scope.clientId,scope.buildingId])).rows;
    const timeline = events.map(e=>{
      let bindingStatus='RECORDED';
      if ((e.source==='CLAIM' || e.source==='ASSESSMENT') && referenceStatus==='HISTORICAL') bindingStatus='HISTORICAL';
      else if (e.source==='REWORK') bindingStatus=lineage;
      else if (e.source==='APPOINTMENT') bindingStatus=appointments.find(a=>a.appointmentId===e.subject_id)?.bindingStatus ?? 'UNVERIFIED';
      else if (e.source==='DISPATCH') bindingStatus=dispatches.find(d=>d.dispatchId===e.subject_id)?.bindingStatus ?? 'UNVERIFIED';
      else if (e.source==='WORK_SESSION') bindingStatus=sessions.find(s=>s.sessionId===e.subject_id)?.bindingStatus ?? 'UNVERIFIED';
      else if (e.source==='COMPLETION') bindingStatus=completionLineage;
      else if (e.source==='QC') {
        const q=qcRows.find(r=>r.id===e.subject_id);
        bindingStatus=!q?.bound ? 'UNVERIFIED' : completionLineage!=='BOUND' ? completionLineage :
          q.id!==latestQc?.id ? 'HISTORICAL' : qcLineage;
      }
      return {id:e.id,source:e.source,type:e.type,subjectId:e.subject_id,actorUserId:e.actor_user_id,
        occurredAt:e.occurred_at_text,result:e.result,bindingStatus};
    });
    return {
      complaint:{complaintId:view.complaintId,complaintNumber:view.complaintNumber,
        status:complaint.claim_id && !claim ? null : view.status,referenceStatus,
        complaintDate:complaint.complaint_date_text,recordedAt:iso(complaint.created_at),
        recordedByUserId:complaint.recorded_by_user_id},
      claim:claim ? {claimId:claim.id,status:view.claimStatus,bindingStatus:referenceStatus} : null,
      assessment:claim ? view.assessment : null,
      rework:rework ? {reworkId:rework.id,status:rework.status,bindingStatus:lineage,executionScopeId:child,
        appointments,dispatch:dispatches[0] ?? null,workSession:sessions[0] ?? null,
        completion:completion ? {id:completion.id,sessionId:completion.session_id,leadUserId:completion.lead_user_id,
          completedAt:iso(completion.completed_at),bindingStatus:completionLineage} : null,
        qc:latestQc ? {runId:latestQc.id,status:latestQc.status,createdAt:iso(latestQc.created_at),
          updatedAt:iso(latestQc.updated_at),bindingStatus:qcLineage,verification:qcVerification} : null} : null,
      timeline,
    };
  });
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
