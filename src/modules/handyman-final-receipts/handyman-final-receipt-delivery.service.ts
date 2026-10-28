import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { applyRetentionToEvidence } from '../evidence-retention-policies/evidence-retention-application.service';
import { createEvidenceStorage, evidenceStorageKey } from '../evidence/storage';
import { authorizeCareDelivery, recheckCareDeliveryWorkspace, type CareDeliveryRecorder } from '../handyman-quotations/handyman-quotation-delivery.service';
import type { CareWorkspacePrincipal } from '../handyman-care-workspace/care-workspace.service';
import { verifyStoredFinalReceipt, type FinalReceiptStored } from './handyman-final-receipt.service';

type Actor = { userId: string; sessionId: string };
export type DeliveryRecorder = (Actor & { principal?: never }) | { principal: CareWorkspacePrincipal; userId?: never; sessionId?: never };
export type DeliveryScope = { buildingId?: string; requestId: string; receiptId: string; version: string };
type Sent = {
  id: string; client_id: string; building_id: string; request_id: string; tenant_company_id: string;
  receipt_id: string; document_version: number; source_sha256: string; pdf_sha256: string; event_type: string;
  channel: string | null; recipient_name: string | null; recipient_contact: string | null; recipient_pic_id: string | null;
  sent_event_id: string | null; evidence_id: string | null; evidence_sha256: string | null;
  actor_user_id: string | null; actor_user_session_id: string | null; care_actor_id: string | null; care_session_id: string | null;
  idempotency_key: string | null; payload_sha256: string | null; reported_occurred_at: Date | null; recorded_at: Date;
};
type Evidence = { id:string; client_id:string; execution_id:string; evidence_type:string; file_reference:string;
  original_file_name:string; mime_type:string; file_size:string; content_sha256:string; retention_state:string; status:string;
  uploaded_by_user_id:string|null; uploaded_by_care_actor_id:string|null; created_at:Date };
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = /^[0-9a-f]{64}$/;
const missing = () => AppError.notFound('Final Receipt delivery resource not found.');
const conflict = (message: string) => new AppError({code:ERROR_CODES.HANDYMAN_FINAL_RECEIPT_DELIVERY_CONFLICT,statusCode:409,message});
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) throw AppError.validation(`Invalid ${field}.`);
  return value.toLowerCase();
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw AppError.validation(`Invalid ${field}.`);
  return value.trim();
}
function checksum(value: unknown, field: string): string {
  if (typeof value !== 'string' || !digest.test(value)) throw AppError.validation(`Invalid ${field}.`);
  return value;
}
function body(value: unknown, allowed: string[]): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k)))
    throw AppError.validation('Invalid Final Receipt delivery payload.');
  return value as Record<string,unknown>;
}
function time(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    throw AppError.validation('occurredAt must be a UTC timestamp with milliseconds.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString()!==value || date.getTime()>Date.now())
    throw AppError.validation('occurredAt cannot be invalid or in the future.');
  return value;
}
function parseScope(input: DeliveryScope) {
  if (input.version !== '1') throw missing();
  return {requestId:uuid(input.requestId,'requestId'),receiptId:uuid(input.receiptId,'receiptId'),
    buildingId:input.buildingId ? uuid(input.buildingId,'buildingId') : undefined};
}
function recorderColumns(recorder: DeliveryRecorder) {
  return recorder.principal
    ? {userId:null, userSessionId:null, careActorId:recorder.principal.careActorId, careSessionId:recorder.principal.sessionId}
    : {userId:recorder.userId, userSessionId:recorder.sessionId, careActorId:null, careSessionId:null};
}
function baseRecorder(recorder: DeliveryRecorder): CareDeliveryRecorder {
  return recorder.principal ? {principal:recorder.principal} : {userId:recorder.userId!};
}
async function lockLocalSession(tx: PoolClient, recorder: DeliveryRecorder) {
  if (recorder.principal) return;
  const session=await tx.query(`SELECT s.id FROM user_sessions s JOIN users u ON u.id=s.user_id AND u.status='ACTIVE'
    WHERE s.id=$1 AND s.user_id=$2 AND s.status='ACTIVE' AND s.expires_at>clock_timestamp() FOR SHARE OF s,u`,
    [recorder.sessionId,recorder.userId]);
  if (!session.rowCount) throw missing();
}
async function authorize(tx: PoolClient, recorder: DeliveryRecorder, scope: ReturnType<typeof parseScope>) {
  const request=await authorizeCareDelivery(tx,baseRecorder(recorder),scope.requestId,scope.buildingId,missing);
  await lockLocalSession(tx,recorder);
  return request;
}
async function recheck(tx: PoolClient, recorder: DeliveryRecorder, request: Awaited<ReturnType<typeof authorize>>) {
  await lockLocalSession(tx,recorder);
  await recheckCareDeliveryWorkspace(tx,baseRecorder(recorder),request);
}
async function document(tx:PoolClient, receiptId:string, requestId?:string): Promise<FinalReceiptStored> {
  const row=(await tx.query<FinalReceiptStored>(`SELECT f.* FROM handyman_final_receipts f JOIN handyman_service_requests r ON r.id=f.request_id
    AND r.client_id=f.client_id AND r.building_id=f.building_id AND r.tenant_company_id=f.tenant_company_id
    WHERE f.id=$1 AND f.status='ISSUED' AND ($2::uuid IS NULL OR f.request_id=$2) FOR SHARE OF f`,[receiptId,requestId ?? null])).rows[0];
  if (!row) throw missing();
  verifyStoredFinalReceipt(row);
  return row;
}
function pinned(doc: FinalReceiptStored, sourceSha256:string, pdfSha256:string) {
  if (doc.source_sha256!==sourceSha256 || doc.pdf_sha256!==pdfSha256)
    throw conflict('The Final Receipt version or checksum is stale.');
}
function eventView(event: Sent) {
  return {id:event.id,type:event.event_type,receiptId:event.receipt_id,documentVersion:event.document_version,
    clientId:event.client_id,buildingId:event.building_id,requestId:event.request_id,tenantCompanyId:event.tenant_company_id,
    sourceSha256:event.source_sha256,pdfSha256:event.pdf_sha256,channel:event.channel,recipientName:event.recipient_name,
    recipientContact:event.recipient_contact,recipientPicId:event.recipient_pic_id,sentEventId:event.sent_event_id,
    evidenceId:event.evidence_id,evidenceSha256:event.evidence_sha256,actorUserId:event.actor_user_id,careActorId:event.care_actor_id,
    reportedOccurredAt:event.reported_occurred_at?.toISOString() ?? null,recordedAt:event.recorded_at.toISOString(),
    verification:event.event_type==='DELIVERED'?'AUTHENTICATED_RECIPIENT_PIC_ACKNOWLEDGEMENT':
      event.event_type==='SENT'?'REPORTED_BY_CARE':'AUTHORIZED_SERVER_DOWNLOAD'};
}
function evidenceView(e:Evidence) {
  return {id:e.id,receiptId:e.execution_id,kind:e.evidence_type,fileName:e.original_file_name,mimeType:e.mime_type,
    byteSize:Number(e.file_size),sha256:e.content_sha256,uploadedByUserId:e.uploaded_by_user_id,
    uploadedByCareActorId:e.uploaded_by_care_actor_id,status:e.status,retentionState:e.retention_state,uploadedAt:e.created_at.toISOString()};
}
const evidenceSql=`SELECT e.id,e.client_id,e.execution_id,e.evidence_type,e.file_reference,e.original_file_name,e.mime_type,e.file_size,
  e.content_sha256,e.retention_state,e.status,d.uploaded_by_user_id,d.uploaded_by_care_actor_id,d.created_at
  FROM handyman_final_receipt_delivery_evidence d JOIN evidence_submissions e ON e.id=d.evidence_id`;
async function getEvidence(tx:PoolClient,receipt:FinalReceiptStored,evidenceId:string):Promise<{row:Evidence;bytes:Buffer}> {
  const row=(await tx.query<Evidence>(`${evidenceSql} WHERE d.receipt_id=$1 AND e.id=$2 AND e.client_id=$3
    AND e.execution_type='HANDYMAN_FINAL_RECEIPT_DELIVERY' AND e.execution_id=$1 AND e.status='ACTIVE'
    AND e.retention_state<>'PURGED' AND e.file_reference=$4 AND e.hash_algorithm='SHA-256'
    AND e.content_hashed_at IS NOT NULL FOR SHARE OF e`,[receipt.id,evidenceId,receipt.client_id,evidenceStorageKey(evidenceId)])).rows[0];
  if (!row || !digest.test(row.content_sha256)) throw conflict('Protected, receipt-bound delivery evidence is required.');
  try {
    const file=await createEvidenceStorage().get(row.file_reference);
    if (!file.size || file.size!==Number(row.file_size) || file.size!==file.buffer.length || sha(file.buffer)!==row.content_sha256) throw new Error('mismatch');
    return {row,bytes:file.buffer};
  } catch { throw conflict('Delivery evidence bytes are unavailable or failed integrity verification.'); }
}
function fileKind(file: Express.Multer.File): {kind:'PHOTO'|'DOCUMENT';mime:string;filename:string;hash:string} {
  const bytes=file.buffer, mime=String(file.mimetype ?? '').toLowerCase();
  if (!Buffer.isBuffer(bytes) || bytes.length<1 || bytes.length>10_485_760 || file.size!==bytes.length)
    throw AppError.validation('Evidence must contain 1 byte to 10 MB.');
  let kind:'PHOTO'|'DOCUMENT';
  if (mime==='application/pdf' && bytes.subarray(0,5).toString()==='%PDF-') kind='DOCUMENT';
  else if ((mime==='image/png' && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) ||
    (mime==='image/jpeg' && bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex'))) ||
    (mime==='image/webp' && bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP')) kind='PHOTO';
  else throw AppError.validation('Delivery evidence must be an actual PDF, PNG, JPEG or WebP file.');
  const filename=text(basename(String(file.originalname ?? '').replace(/\\/g,'/')),'fileName',255);
  if (/[\u0000-\u001f\u007f]/.test(filename)) throw AppError.validation('Invalid fileName.');
  return {kind,mime,filename,hash:sha(bytes)};
}
async function lockKey(tx:PoolClient,kind:string,recorder:DeliveryRecorder,key:string) {
  const actor=recorderColumns(recorder);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`final-receipt:${kind}:${actor.userId?'user:'+actor.userId:'care:'+actor.careActorId}:${key}`]);
}
function priorColumn(recorder:DeliveryRecorder,which:'event'|'evidence') {
  const actor=recorderColumns(recorder);
  return which==='event' ? {column:actor.userId?'actor_user_id':'care_actor_id',id:actor.userId ?? actor.careActorId}
    : {column:actor.userId?'uploaded_by_user_id':'uploaded_by_care_actor_id',id:actor.userId ?? actor.careActorId};
}

/** Preflight before multipart buffering, followed by the same check inside the write. */
export async function authorizeFinalDeliveryUpload(recorder:DeliveryRecorder,input:DeliveryScope) {
  const scope=parseScope(input);
  await withTransaction(async tx=>{ await authorize(tx,recorder,scope); await document(tx,scope.receiptId,scope.requestId); });
}
export async function uploadFinalDeliveryEvidence(recorder:DeliveryRecorder,input:DeliveryScope,value:unknown,file:Express.Multer.File) {
  const scope=parseScope(input), b=body(value,['idempotencyKey']), key=text(b.idempotencyKey,'idempotencyKey',128), fileInfo=fileKind(file);
  const fingerprint=sha(stableJson({receiptId:scope.receiptId,requestId:scope.requestId,...fileInfo}));
  const storage=createEvidenceStorage(); let written:string|null=null;
  let outcome:{id:string;replayed:boolean};
  try {
    outcome=await withTransaction(async tx=>{
      const request=await authorize(tx,recorder,scope), doc=await document(tx,scope.receiptId,scope.requestId);
      await lockKey(tx,'evidence',recorder,key);
      const actor=priorColumn(recorder,'evidence');
      const prior=(await tx.query<{evidence_id:string;payload_sha256:string}>(`SELECT evidence_id,payload_sha256
        FROM handyman_final_receipt_delivery_evidence WHERE ${actor.column}=$1 AND idempotency_key=$2`,[actor.id,key])).rows[0];
      if (prior) {
        if (prior.payload_sha256!==fingerprint) throw conflict('Idempotency key was already used for different evidence.');
        return {id:prior.evidence_id,replayed:true};
      }
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`final-receipt:evidence-count:${doc.id}`]);
      const count=(await tx.query<{n:number}>('SELECT count(*)::int n FROM handyman_final_receipt_delivery_evidence WHERE receipt_id=$1',[doc.id])).rows[0].n;
      if (count>=100) throw conflict('A Final Receipt may have at most 100 delivery evidence files.');
      const evidenceId=randomUUID(), storageKey=evidenceStorageKey(evidenceId), columns=recorderColumns(recorder);
      written=storageKey; await storage.put(storageKey,{buffer:file.buffer,mimeType:fileInfo.mime});
      const stored=await storage.get(storageKey);
      if (stored.size!==file.buffer.length || sha(stored.buffer)!==fileInfo.hash) throw conflict('Evidence storage verification failed.');
      await recheck(tx,recorder,request);
      await tx.query(`INSERT INTO evidence_submissions(id,client_id,execution_type,execution_id,evidence_type,file_reference,
        original_file_name,mime_type,file_size,captured_at,submitted_by_user_id,content_sha256,content_hashed_at,hash_algorithm)
        VALUES($1,$2,'HANDYMAN_FINAL_RECEIPT_DELIVERY',$3,$4,$5,$6,$7,$8,NULL,$9,$10,NOW(),'SHA-256')`,
      [evidenceId,doc.client_id,doc.id,fileInfo.kind,storageKey,fileInfo.filename,fileInfo.mime,file.buffer.length,columns.userId,fileInfo.hash]);
      await tx.query(`INSERT INTO handyman_final_receipt_delivery_evidence(evidence_id,receipt_id,uploaded_by_user_id,uploaded_user_session_id,
        uploaded_by_care_actor_id,uploaded_care_session_id,idempotency_key,payload_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [evidenceId,doc.id,columns.userId,columns.userSessionId,columns.careActorId,columns.careSessionId,key,fingerprint]);
      return {id:evidenceId,replayed:false};
    });
  } catch(error) { if (written) await storage.remove(written).catch(()=>undefined); throw error; }
  await applyRetentionToEvidence(outcome.id,recorder.userId ?? null);
  return withTransaction(async tx=>{
    await authorize(tx,recorder,scope); const doc=await document(tx,scope.receiptId,scope.requestId);
    const evidence=await getEvidence(tx,doc,outcome.id);
    return {evidence:evidenceView(evidence.row),replayed:outcome.replayed};
  });
}
export async function readFinalDeliveryEvidence(recorder:DeliveryRecorder,input:DeliveryScope,evidenceInput:string) {
  const scope=parseScope(input), id=uuid(evidenceInput,'evidenceId');
  return withTransaction(async tx=>{
    const request=await authorize(tx,recorder,scope), doc=await document(tx,scope.receiptId,scope.requestId);
    const evidence=await getEvidence(tx,doc,id); await recheck(tx,recorder,request);
    return {buffer:evidence.bytes,mimeType:evidence.row.mime_type,fileName:evidence.row.original_file_name};
  });
}
export async function listFinalDelivery(recorder:DeliveryRecorder,input:DeliveryScope) {
  const scope=parseScope(input);
  return withTransaction(async tx=>{
    const request=await authorize(tx,recorder,scope), doc=await document(tx,scope.receiptId,scope.requestId);
    const rows=(await tx.query<Sent>(`SELECT * FROM handyman_final_receipt_delivery_events
      WHERE receipt_id=$1 AND client_id=$2 AND building_id=$3 AND request_id=$4 AND tenant_company_id=$5 ORDER BY recorded_at,id`,
    [doc.id,doc.client_id,doc.building_id,doc.request_id,doc.tenant_company_id])).rows;
    await recheck(tx,recorder,request);
    return {receipt:{id:doc.id,number:doc.document_number,version:1,sourceSha256:doc.source_sha256,pdfSha256:doc.pdf_sha256},events:rows.map(eventView)};
  });
}
export async function recordFinalDeliverySent(recorder:DeliveryRecorder,input:DeliveryScope,value:unknown) {
  const scope=parseScope(input);
  const raw=body(value,['type','sourceSha256','pdfSha256','channel','recipientName','recipientContact','recipientPicId','evidenceId','occurredAt','idempotencyKey']);
  if (raw.type==='DELIVERED') throw conflict('DELIVERED requires an authenticated acknowledgment by the exact recipient PIC; Care evidence alone is insufficient.');
  if (raw.type!=='SENT' || !['WHATSAPP','EMAIL','DIRECT'].includes(String(raw.channel))) throw AppError.validation('Only manual SENT is accepted.');
  const command={type:'SENT',sourceSha256:checksum(raw.sourceSha256,'sourceSha256'),pdfSha256:checksum(raw.pdfSha256,'pdfSha256'),
    channel:String(raw.channel),recipientName:text(raw.recipientName,'recipientName',200),
    recipientContact:raw.recipientContact == null ? null : text(raw.recipientContact,'recipientContact',200),
    recipientPicId:raw.recipientPicId == null ? null : uuid(raw.recipientPicId,'recipientPicId'),
    evidenceId:uuid(raw.evidenceId,'evidenceId'),occurredAt:time(raw.occurredAt),idempotencyKey:text(raw.idempotencyKey,'idempotencyKey',128)};
  if (command.channel!=='DIRECT' && !command.recipientContact) throw AppError.validation('recipientContact is required for WhatsApp or email.');
  const fingerprint=sha(stableJson({receiptId:scope.receiptId,requestId:scope.requestId,version:1,...command}));
  return withTransaction(async tx=>{
    const request=await authorize(tx,recorder,scope), doc=await document(tx,scope.receiptId,scope.requestId);
    pinned(doc,command.sourceSha256,command.pdfSha256);
    await lockKey(tx,'event',recorder,command.idempotencyKey);
    const actor=priorColumn(recorder,'event');
    const prior=(await tx.query<Sent>(`SELECT * FROM handyman_final_receipt_delivery_events WHERE ${actor.column}=$1 AND idempotency_key=$2`,
      [actor.id,command.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.payload_sha256!==fingerprint) throw conflict('Idempotency key was already used for a different event.');
      return {event:eventView(prior),replayed:true};
    }
    if (new Date(command.occurredAt)<doc.issued_at) throw conflict('SENT cannot precede Final Receipt issuance.');
    if (command.recipientPicId) {
      const pic=await tx.query(`SELECT id FROM tenant_pics WHERE id=$1 AND tenant_company_id=$2 AND status='ACTIVE' FOR SHARE`,
        [command.recipientPicId,doc.tenant_company_id]);
      if (!pic.rowCount) throw conflict('The reported recipient PIC must belong to this tenant.');
    }
    const evidence=await getEvidence(tx,doc,command.evidenceId); await recheck(tx,recorder,request);
    const columns=recorderColumns(recorder);
    const event=(await tx.query<Sent>(`INSERT INTO handyman_final_receipt_delivery_events
      (id,client_id,building_id,request_id,tenant_company_id,receipt_id,document_version,source_sha256,pdf_sha256,event_type,
       channel,recipient_name,recipient_contact,recipient_pic_id,evidence_id,evidence_sha256,actor_user_id,actor_user_session_id,
       care_actor_id,care_session_id,idempotency_key,payload_sha256,reported_occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,'SENT',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
    [randomUUID(),doc.client_id,doc.building_id,doc.request_id,doc.tenant_company_id,doc.id,doc.source_sha256,doc.pdf_sha256,
      command.channel,command.recipientName,command.recipientContact,command.recipientPicId,command.evidenceId,evidence.row.content_sha256,
      columns.userId,columns.userSessionId,columns.careActorId,columns.careSessionId,command.idempotencyKey,fingerprint,command.occurredAt])).rows[0];
    return {event:eventView(event),replayed:false};
  });
}

async function sentForPic(tx:PoolClient,actor:Actor,receiptId:string,sentId:string) {
  const doc=await document(tx,receiptId);
  const sent=(await tx.query<Sent>(`SELECT * FROM handyman_final_receipt_delivery_events
    WHERE id=$1 AND receipt_id=$2 AND event_type='SENT'`,[sentId,doc.id])).rows[0];
  if (!sent || !sent.recipient_pic_id) throw missing();
  const authorized=await tx.query(`SELECT p.id FROM tenant_pics p JOIN users u ON u.id=p.user_id AND u.status='ACTIVE'
    JOIN user_sessions s ON s.user_id=u.id AND s.id=$4 AND s.status='ACTIVE' AND s.expires_at>clock_timestamp()
    JOIN user_building_assignments a ON a.user_id=u.id AND a.building_id=$5 AND a.status='ACTIVE'
    JOIN buildings b ON b.id=a.building_id AND b.status='ACTIVE' JOIN properties pr ON pr.id=b.property_id AND pr.client_id=$6
    WHERE p.id=$1 AND p.tenant_company_id=$2 AND p.user_id=$3 AND p.status='ACTIVE'
    FOR SHARE OF p,u,s,a,b,pr`,[sent.recipient_pic_id,doc.tenant_company_id,actor.userId,actor.sessionId,doc.building_id,doc.client_id]);
  if (!authorized.rowCount) throw missing();
  pinned(doc,sent.source_sha256,sent.pdf_sha256);
  return {doc,sent};
}
function picSentView(doc:FinalReceiptStored,sent:Sent) {
  return {receipt:{id:doc.id,number:doc.document_number,version:1,sourceSha256:doc.source_sha256,pdfSha256:doc.pdf_sha256},
    sent:{id:sent.id,channel:sent.channel,recipientName:sent.recipient_name,reportedOccurredAt:sent.reported_occurred_at?.toISOString(),
      recordedAt:sent.recorded_at.toISOString()}};
}
/** The intended authenticated PIC can inspect only this one reported SENT. */
export async function inspectFinalDeliveryForRecipient(actor:Actor,receiptInput:string,version:string,sentInput:string) {
  if (version!=='1') throw missing();
  const receipt=uuid(receiptInput,'receiptId'),sentId=uuid(sentInput,'sentEventId');
  return withTransaction(async tx=>{
    const {doc,sent}=await sentForPic(tx,actor,receipt,sentId);
    const acknowledgment=(await tx.query<Sent>(`SELECT * FROM handyman_final_receipt_delivery_events
      WHERE sent_event_id=$1 AND event_type='DELIVERED'`,[sent.id])).rows[0];
    return {...picSentView(doc,sent),acknowledgedAt:acknowledgment?.recorded_at.toISOString() ?? null};
  });
}
/** Only the exact recipient's own live user session can create DELIVERED. */
export async function acknowledgeFinalDelivery(actor:Actor,receiptInput:string,version:string,sentInput:string,value:unknown) {
  if (version!=='1') throw missing();
  const receipt=uuid(receiptInput,'receiptId'),sentId=uuid(sentInput,'sentEventId');
  const b=body(value,['sourceSha256','pdfSha256','acknowledged','idempotencyKey']);
  if (b.acknowledged!==true) throw AppError.validation('Explicit recipient acknowledgment is required.');
  const command={sourceSha256:checksum(b.sourceSha256,'sourceSha256'),pdfSha256:checksum(b.pdfSha256,'pdfSha256'),
    acknowledged:true,idempotencyKey:text(b.idempotencyKey,'idempotencyKey',128)};
  const fingerprint=sha(stableJson({receiptId:receipt,sentEventId:sentId,version:1,...command}));
  const recorder:DeliveryRecorder=actor;
  return withTransaction(async tx=>{
    const {doc,sent}=await sentForPic(tx,actor,receipt,sentId); pinned(doc,command.sourceSha256,command.pdfSha256);
    await lockKey(tx,'event',recorder,command.idempotencyKey);
    const prior=(await tx.query<Sent>(`SELECT * FROM handyman_final_receipt_delivery_events
      WHERE actor_user_id=$1 AND idempotency_key=$2`,[actor.userId,command.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.payload_sha256!==fingerprint) throw conflict('Idempotency key was already used for a different event.');
      return {event:eventView(prior),replayed:true};
    }
    // Serialize acknowledgments with different keys for the same SENT.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`final-receipt:ack:${sent.id}`]);
    const existing=(await tx.query<Sent>(`SELECT * FROM handyman_final_receipt_delivery_events
      WHERE sent_event_id=$1 AND event_type='DELIVERED'`,[sent.id])).rows[0];
    if (existing) throw conflict('This SENT event has already been acknowledged.');
    // The session can naturally expire while awaiting locks.
    await sentForPic(tx,actor,receipt,sentId);
    const event=(await tx.query<Sent>(`INSERT INTO handyman_final_receipt_delivery_events
      (id,client_id,building_id,request_id,tenant_company_id,receipt_id,document_version,source_sha256,pdf_sha256,event_type,
       channel,recipient_name,recipient_contact,recipient_pic_id,sent_event_id,actor_user_id,actor_user_session_id,idempotency_key,payload_sha256)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,'DELIVERED',$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [randomUUID(),doc.client_id,doc.building_id,doc.request_id,doc.tenant_company_id,doc.id,doc.source_sha256,doc.pdf_sha256,
      sent.channel,sent.recipient_name,sent.recipient_contact,sent.recipient_pic_id,sent.id,actor.userId,actor.sessionId,
      command.idempotencyKey,fingerprint])).rows[0];
    return {event:eventView(event),replayed:false};
  });
}

type Downloaded = {id:string;sourceChecksum:string;pdfChecksum:string;version:1};
async function insertDownload(tx:PoolClient,doc:FinalReceiptStored,recorder:DeliveryRecorder,downloaded:Downloaded) {
  if (downloaded.id!==doc.id || downloaded.version!==1) throw conflict('Downloaded Final Receipt does not match its issued document.');
  pinned(doc,downloaded.sourceChecksum,downloaded.pdfChecksum);
  const a=recorderColumns(recorder);
  await tx.query(`INSERT INTO handyman_final_receipt_delivery_events(id,client_id,building_id,request_id,tenant_company_id,
    receipt_id,document_version,source_sha256,pdf_sha256,event_type,actor_user_id,actor_user_session_id,care_actor_id,care_session_id)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,'DOWNLOADED',$9,$10,$11,$12)`,
  [randomUUID(),doc.client_id,doc.building_id,doc.request_id,doc.tenant_company_id,doc.id,doc.source_sha256,doc.pdf_sha256,
    a.userId,a.userSessionId,a.careActorId,a.careSessionId]);
}
/** Called only from the already-authorized, byte-verified local PDF GET. */
export async function recordLocalFinalReceiptDownload(actor:Actor,downloaded:Downloaded,served:()=>Promise<void>) {
  await withTransaction(async tx=>{
    const doc=await document(tx,downloaded.id);
    const allowed=await tx.query(`SELECT u.id FROM users u JOIN user_sessions s ON s.user_id=u.id
      JOIN user_building_assignments a ON a.user_id=u.id AND a.building_id=$3 AND a.status='ACTIVE'
      JOIN buildings b ON b.id=a.building_id AND b.status='ACTIVE' JOIN properties pr ON pr.id=b.property_id AND pr.client_id=$4
      JOIN user_role_assignments ura ON ura.user_id=u.id AND ura.status='ACTIVE'
      JOIN roles r ON r.id=ura.role_id AND r.status='ACTIVE' JOIN role_permission_assignments rpa ON rpa.role_id=r.id AND rpa.status='ACTIVE'
      JOIN permissions p ON p.id=rpa.permission_id AND p.status='ACTIVE' AND p.code IN ('handyman.care.building','handyman.finance.read')
      WHERE u.id=$1 AND u.status='ACTIVE' AND s.id=$2 AND s.status='ACTIVE' AND s.expires_at>clock_timestamp()
      LIMIT 1 FOR SHARE OF u,s,a,b,pr,ura,r,rpa,p`,[actor.userId,actor.sessionId,doc.building_id,doc.client_id]);
    if (!allowed.rowCount) throw missing();
    await insertDownload(tx,doc,actor,downloaded);
    await served(); // Roll back if the PDF response does not finish.
  });
}
/** Workspace grant and current represented occupancy are rechecked in the write. */
export async function recordWorkspaceFinalReceiptDownload(principal:CareWorkspacePrincipal,requestId:string,downloaded:Downloaded,served:()=>Promise<void>) {
  const scope={requestId:uuid(requestId,'requestId'),receiptId:uuid(downloaded.id,'receiptId'),buildingId:undefined},recorder:DeliveryRecorder={principal};
  await withTransaction(async tx=>{
    const request=await authorize(tx,recorder,scope),doc=await document(tx,scope.receiptId,scope.requestId);
    await recheck(tx,recorder,request); await insertDownload(tx,doc,recorder,downloaded);
    await served();
  });
}
