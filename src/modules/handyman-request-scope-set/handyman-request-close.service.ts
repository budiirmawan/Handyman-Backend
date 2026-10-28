import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { evaluateHandymanRequestCloseReadiness } from './handyman-request-close-readiness.service';
import { readAuthorizedHandymanRequestScopeSetInTransaction } from './handyman-request-scope-set.service';

type Actor = { userId: string; sessionId: string };
type ScopeSet = Awaited<ReturnType<typeof readAuthorizedHandymanRequestScopeSetInTransaction>>;
type Readiness = Awaited<ReturnType<typeof evaluateHandymanRequestCloseReadiness>>['readiness'];
type CloseRow = {
  id:string; request_id:string; client_id:string; building_id:string; tenant_company_id:string;
  actor_user_id:string; actor_session_id:string; occurred_at:Date; reason:string; idempotency_key:string;
  scope_set_revision:string; scope_set_fingerprint:string; source_snapshot:Record<string,unknown>;
  source_canonical:string; source_sha256:string;
};
const sha = (value:string) => createHash('sha256').update(value).digest('hex');
const denied = () => new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,
  message:'Active Operations/Manager authority, authenticated session, and exact Client/Building access are required.'});
const changed = () => new AppError({code:ERROR_CODES.HANDYMAN_REQUEST_SCOPE_SET_CHANGED,statusCode:409,
  message:'The Request scope set changed; obtain and review a new close-readiness snapshot.'});

function publicEvent(row:CloseRow) {
  if (stableJson(row.source_snapshot)!==row.source_canonical || sha(row.source_canonical)!==row.source_sha256)
    throw new AppError({code:ERROR_CODES.CONFLICT,statusCode:409,message:'Request close event failed integrity verification.'});
  return {id:row.id,status:'CLOSED' as const,requestId:row.request_id,clientId:row.client_id,buildingId:row.building_id,
    tenantCompanyId:row.tenant_company_id,actorUserId:row.actor_user_id,actorSessionId:row.actor_session_id,
    occurredAt:row.occurred_at.toISOString(),reason:row.reason,idempotencyKey:row.idempotency_key,
    scopeSetRevision:row.scope_set_revision,scopeSetFingerprint:row.scope_set_fingerprint,
    sourceSha256:row.source_sha256,sourceSnapshot:row.source_snapshot};
}

/** Hold the actual session, building assignment and every required active RBAC
 * grant until commit, rather than relying on a role name or an earlier token. */
async function authorize(tx:PoolClient,actor:Actor,scope:ScopeSet,write:boolean) {
  const required=['tenant_company.manage','handyman.commercial.manage','handyman.finance.read','handyman.customer_tax.read',
    ...(write ? ['finding.close'] : [])];
  const grants=await tx.query<{code:string}>(`SELECT pe.code FROM users u
    JOIN user_sessions se ON se.user_id=u.id AND se.id=$2 AND se.status='ACTIVE' AND se.expires_at>clock_timestamp()
    JOIN user_building_assignments a ON a.user_id=u.id AND a.building_id=$3 AND a.status='ACTIVE'
    JOIN buildings b ON b.id=a.building_id AND b.status='ACTIVE'
    JOIN properties pr ON pr.id=b.property_id AND pr.client_id=$4
    JOIN user_role_assignments ura ON ura.user_id=u.id AND ura.status='ACTIVE'
    JOIN roles ro ON ro.id=ura.role_id AND ro.status='ACTIVE'
    JOIN role_permission_assignments rpa ON rpa.role_id=ro.id AND rpa.status='ACTIVE'
    JOIN permissions pe ON pe.id=rpa.permission_id AND pe.status='ACTIVE' AND pe.code=ANY($5::text[])
    WHERE u.id=$1 AND u.status='ACTIVE' FOR SHARE OF u,se,a,b,pr,ura,ro,rpa,pe`,
    [actor.userId,actor.sessionId,scope.buildingId,scope.clientId,required]);
  const present=new Set(grants.rows.map(r=>r.code));
  if (required.some(code=>!present.has(code))) throw denied();
  if (write) {
    const field=(await tx.query<{hit:boolean}>(`SELECT (
      EXISTS(SELECT 1 FROM handyman_execution_scopes s
        JOIN handyman_execution_scope_assignments a ON a.execution_scope_id=s.id
        JOIN handyman_crew_memberships m ON m.handyman_crew_id=a.handyman_crew_id
        JOIN handyman_worker_contexts wc ON wc.id=m.handyman_worker_context_id
        JOIN workforce_profiles wp ON wp.id=wc.workforce_profile_id
        WHERE s.handyman_request_id=$1 AND s.scope_kind='ORIGINAL' AND wp.user_id=$2)
      OR EXISTS(SELECT 1 FROM handyman_visit_appointments v WHERE v.handyman_request_id=$1
        AND v.resource_type='INSPECTOR_USER' AND v.resource_id=$2)) AS hit`,[scope.requestId,actor.userId])).rows[0];
    if (field?.hit) throw denied();
  }
}

async function existingEvent(tx:PoolClient,requestId:string) {
  return (await tx.query<CloseRow>('SELECT * FROM handyman_request_close_events WHERE request_id=$1',[requestId])).rows[0] ?? null;
}

function inputText(value:unknown,name:string,max:number) {
  if (typeof value!=='string' || !value.trim() || value.trim().length>max)
    throw AppError.validation(`${name} must contain 1..${max} characters.`);
  return value.trim();
}
function closeInput(input:unknown) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw AppError.validation('A close command body is required.');
  const body=input as Record<string,unknown>;
  const fields=['reason','idempotencyKey','expectedScopeSetRevision','expectedScopeSetFingerprint'];
  if (Object.keys(body).some(key=>!fields.includes(key))) throw AppError.validation('Unexpected Request close command field.');
  const reason=inputText(body.reason,'reason',500),idempotencyKey=inputText(body.idempotencyKey,'idempotencyKey',128);
  const revision=body.expectedScopeSetRevision, fingerprint=body.expectedScopeSetFingerprint;
  if (typeof revision!=='string' || !/^(0|[1-9][0-9]{0,18})$/.test(revision) || BigInt(revision)>9223372036854775807n)
    throw AppError.validation('expectedScopeSetRevision must be the canonical revision string from close-readiness.');
  if (typeof fingerprint!=='string' || !/^[0-9a-f]{64}$/.test(fingerprint))
    throw AppError.validation('expectedScopeSetFingerprint must be the lowercase SHA-256 from close-readiness.');
  return {reason,idempotencyKey,revision,fingerprint};
}

/** Capture immutable artifact versions, financial allocations/receipts and the
 * exact authenticated delivery event. The evaluator already held the scopes,
 * ledger, invoice source fence and approval heads while verifying these facts. */
async function supportingSources(tx:PoolClient,scope:ScopeSet,readiness:Readiness) {
  const sources=[];
  for (const member of scope.scopes) {
    const view=readiness.scopes.find(s=>s.executionScopeId===member.executionScopeId);
    if (!view?.invoiceId || !view.finalReceiptId) throw changed();
    const invoice=(await tx.query(`SELECT i.id,i.transaction_id,i.classification_id,i.document_number,i.total_amount::text,
      i.source_sha256,i.pdf_sha256,i.source_snapshot->'calculation'->'classification'->'pin' AS classification_pin,
      f.revision::text AS source_fence_revision
      FROM handyman_official_invoices i JOIN handyman_invoice_source_fences f ON f.execution_scope_id=i.execution_scope_id
      WHERE i.id=$1 AND i.execution_scope_id=$2`,[view.invoiceId,member.executionScopeId])).rows[0];
    const receipt=(await tx.query(`SELECT id,invoice_id,document_number,source_sha256,pdf_sha256,
      source_snapshot->'payments' AS payments,source_snapshot->'corrections' AS corrections,
      source_snapshot->'settlement' AS settlement FROM handyman_final_receipts WHERE id=$1 AND invoice_id=$2`,
      [view.finalReceiptId,view.invoiceId])).rows[0];
    const bast=(await tx.query(`SELECT id,source_sha256,pdf_sha256,qc_finish_event_id
      FROM handyman_bast_official_documents WHERE id=$1 AND execution_scope_id=$2`,
      [member.bastAcceptance.officialDocumentId,member.executionScopeId])).rows[0];
    const quote=(await tx.query(`SELECT id,quotation_version_id,source_sha256,pdf_sha256
      FROM handyman_quotation_documents WHERE quotation_version_id=$1`,[member.approvalVersionId])).rows[0];
    const delivery=(await tx.query(`SELECT d.id,d.sent_event_id,d.recipient_pic_id,d.actor_user_id,d.actor_user_session_id,
      d.document_version,d.source_sha256,d.pdf_sha256,d.recorded_at
      FROM handyman_final_receipt_delivery_events d JOIN handyman_final_receipt_delivery_events sent
        ON sent.id=d.sent_event_id AND sent.event_type='SENT' AND sent.receipt_id=d.receipt_id
      WHERE d.event_type='DELIVERED' AND d.receipt_id=$1 AND d.client_id=$2 AND sent.client_id=d.client_id
        AND d.building_id=$3 AND sent.building_id=d.building_id AND d.request_id=$4 AND sent.request_id=d.request_id
        AND d.tenant_company_id=$5 AND sent.tenant_company_id=d.tenant_company_id
        AND d.document_version=1 AND sent.document_version=1 AND d.source_sha256=$6 AND sent.source_sha256=d.source_sha256
        AND d.pdf_sha256=$7 AND sent.pdf_sha256=d.pdf_sha256 AND d.recipient_pic_id IS NOT NULL
        AND sent.recipient_pic_id=d.recipient_pic_id AND d.actor_user_id IS NOT NULL AND d.actor_user_session_id IS NOT NULL
        AND d.channel=sent.channel AND d.recipient_name=sent.recipient_name
        AND d.recipient_contact IS NOT DISTINCT FROM sent.recipient_contact ORDER BY d.recorded_at,d.id LIMIT 1`,
      [view.finalReceiptId,scope.clientId,scope.buildingId,scope.requestId,scope.tenantCompanyId,receipt?.source_sha256,receipt?.pdf_sha256])).rows[0];
    const certificate=view.warrantyCertificateId ? (await tx.query(`SELECT id,warranty_id,source_sha256,pdf_sha256,manifest_id,manifest_version
      FROM handyman_warranty_certificates WHERE id=$1 AND execution_scope_id=$2`,[view.warrantyCertificateId,member.executionScopeId])).rows[0] : null;
    if (!invoice || !receipt || !bast || !quote || !delivery || (view.warrantyCertificateId && !certificate)) throw changed();
    // Dates returned by pg are converted explicitly before canonical JSON.
    delivery.recorded_at=(delivery.recorded_at as Date).toISOString();
    sources.push({executionScopeId:member.executionScopeId,approval:{quotationId:member.quotationId,
      versionId:member.approvalVersionId,versionNumber:member.approvalVersionNumber,decisionId:member.approvalDecisionId,document:quote},
      completion:member.completion,bastAcceptance:member.bastAcceptance,bastDocument:bast,
      invoice,finalReceipt:receipt,delivery,warranty:{status:view.warrantyStatus,certificate}});
  }
  return sources;
}

export async function getHandymanRequestClose(requestId:unknown,actor:Actor) {
  return withTransaction(async tx=>{
    const scope=await readAuthorizedHandymanRequestScopeSetInTransaction(tx,requestId,actor.userId);
    await authorize(tx,actor,scope,false);
    const event=await existingEvent(tx,scope.requestId);
    return {requestId:scope.requestId,clientId:scope.clientId,buildingId:scope.buildingId,
      status:event?'CLOSED' as const:'OPEN' as const,event:event?publicEvent(event):null};
  });
}

export async function closeHandymanRequest(requestId:unknown,actor:Actor,input:unknown) {
  const command=closeInput(input);
  return withTransaction(async tx=>{
    const isolation=(await tx.query<{mode:string}>("SELECT current_setting('transaction_isolation') AS mode")).rows[0]?.mode;
    if (isolation!=='read committed') throw new AppError({code:ERROR_CODES.CONFLICT,statusCode:409,
      message:'Request CLOSE requires READ COMMITTED to recheck committed source state.'});
    // Existing original scopes -> Request -> exclusive revision fence -> each
    // ledger/invoice authority. This remains held until the event commits.
    const scope=await readAuthorizedHandymanRequestScopeSetInTransaction(tx,requestId,actor.userId,{close:true});
    await authorize(tx,actor,scope,true);
    const existing=await existingEvent(tx,scope.requestId);
    if (existing) {
      if (existing.actor_user_id===actor.userId && existing.idempotency_key===command.idempotencyKey &&
          existing.reason===command.reason && existing.scope_set_revision===command.revision &&
          existing.scope_set_fingerprint===command.fingerprint)
        return {status:'CLOSED' as const,event:publicEvent(existing),replayed:true};
      throw new AppError({code:ERROR_CODES.HANDYMAN_REQUEST_ALREADY_CLOSED,statusCode:409,
        message:'Main Request is already CLOSED; a different close command cannot replace its event.'});
    }
    if (scope.revision!==command.revision || scope.fingerprint!==command.fingerprint) throw changed();
    const {readiness}=await evaluateHandymanRequestCloseReadiness(tx,scope.requestId,actor.userId,{scopeSet:scope});
    if (readiness.status!=='READY') throw new AppError({code:ERROR_CODES.HANDYMAN_REQUEST_CLOSE_BLOCKED,statusCode:409,
      message:'Main Request cannot close while live readiness is BLOCKED.',details:readiness.blockers});
    const sources=await supportingSources(tx,scope,readiness);
    const occurredAt=(await tx.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;
    const source={protocol:'HANDYMAN_REQUEST_CLOSE_V1',status:'CLOSED',requestId:scope.requestId,clientId:scope.clientId,
      buildingId:scope.buildingId,tenantCompanyId:scope.tenantCompanyId,actorUserId:actor.userId,
      actorSessionId:actor.sessionId,occurredAt:occurredAt.toISOString(),reason:command.reason,
      scopeSetRevision:scope.revision,scopeSetFingerprint:scope.fingerprint,readiness,sources};
    const canonical=stableJson(source);
    const row=(await tx.query<CloseRow>(`INSERT INTO handyman_request_close_events
      (id,request_id,client_id,building_id,tenant_company_id,actor_user_id,actor_session_id,occurred_at,reason,idempotency_key,
       scope_set_revision,scope_set_fingerprint,source_snapshot,source_canonical,source_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::text,$15) RETURNING *`,
      [randomUUID(),scope.requestId,scope.clientId,scope.buildingId,scope.tenantCompanyId,actor.userId,actor.sessionId,
        occurredAt,command.reason,command.idempotencyKey,scope.revision,scope.fingerprint,canonical,canonical,sha(canonical)])).rows[0];
    return {status:'CLOSED' as const,event:publicEvent(row),replayed:false};
  });
}
