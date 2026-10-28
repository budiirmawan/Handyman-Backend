import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { assertHandymanQuotationPricingAuthority } from '../handyman-quotations/handyman-quotation-access';
import { quotationDecisionFingerprint, careQuotationDecisionFingerprint } from '../handyman-quotations/handyman-quotation-decision-fingerprint';
import { findQuotationDecisionOffer } from '../handyman-quotations/handyman-quotation-document.service';
import { quotationCommercialTarget } from '../handyman-commercial-consent/commercial-consent.targets';
import { parseCommercialConsentAssertion } from '../handyman-commercial-consent/commercial-consent.assertion';
import { assertCurrentGuardedHandymanQcPass } from '../handyman-evidence-qc/handyman-qc-pass-gate';
import { requireVerifiedCompletionForIssue } from '../handyman-completion-manifest/handyman-completion-manifest.service';

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
const changed = () => new AppError({ code: ERROR_CODES.HANDYMAN_REQUEST_SCOPE_SET_CHANGED, statusCode: 409,
  message: 'The Request scope set changed; obtain and review a new scope-set snapshot.' });
const uuid = (value: unknown) => {
  if (typeof value !== 'string' || !isValidUuid(value)) throw AppError.validation('A valid handymanRequestId is required.');
  return value.toLowerCase();
};
type RequestRow = QueryResultRow & { id: string; client_id: string; building_id: string; tenant_company_id: string;
  tenant_pic_id: string | null; space_id: string | null; channel_attribution_id: string; status: string; attribution_matches: boolean };
type Version = QueryResultRow & { id: string; quotation_id: string; version_number: number; status: string; valid_until: Date | null };
type Decision = QueryResultRow & { id: string; client_id: string; quotation_id: string; quotation_version_id: string;
  decision: string; tenant_company_id: string; tenant_pic_id: string | null; decided_by_user_id: string | null;
  decided_by_care_actor_id: string | null; commercial_consent_id: string | null; request_fingerprint: string;
  offer_document_id: string | null; offer_source_sha256: string | null; offer_pdf_sha256: string | null };
type Scope = QueryResultRow & { id: string; client_id: string; building_id: string; handyman_request_id: string;
  tenant_company_id: string; tenant_pic_id: string | null; space_id: string | null; channel_attribution_id: string;
  quotation_id: string; approved_quotation_version_id: string; quotation_decision_id: string; status: string;
  created_by_user_id: string | null; created_by_care_actor_id: string | null };

type Blocker = { code: string; message: string };
function blocker(code: string, message: string): Blocker { return { code, message }; }
async function requestAt(tx: PoolClient, id: string): Promise<RequestRow> {
  const row = (await tx.query<RequestRow>(`SELECT r.id,r.client_id,r.building_id,r.tenant_company_id,r.tenant_pic_id,
    r.space_id,r.channel_attribution_id,r.status,
    (a.id IS NOT NULL AND a.client_id=r.client_id AND a.building_id=r.building_id
      AND a.tenant_company_id=r.tenant_company_id AND a.tenant_pic_id IS NOT DISTINCT FROM r.tenant_pic_id
      AND a.space_id IS NOT DISTINCT FROM r.space_id AND a.origin_channel=r.origin_channel
      AND a.origin_reference IS NOT DISTINCT FROM r.origin_reference
      AND EXISTS (SELECT 1 FROM tenant_companies tc WHERE tc.id=r.tenant_company_id AND tc.client_id=r.client_id)
      AND EXISTS (SELECT 1 FROM buildings b JOIN properties p ON p.id=b.property_id
                  WHERE b.id=r.building_id AND p.client_id=r.client_id)
      AND (r.tenant_pic_id IS NULL OR EXISTS (SELECT 1 FROM tenant_pics tp
                  WHERE tp.id=r.tenant_pic_id AND tp.tenant_company_id=r.tenant_company_id))
      AND (r.space_id IS NULL OR EXISTS (SELECT 1 FROM spaces sp JOIN rooms ro ON ro.id=sp.room_id
                  JOIN areas ar ON ar.id=ro.area_id JOIN floors f ON f.id=ar.floor_id
                  WHERE sp.id=r.space_id AND f.building_id=r.building_id))) AS attribution_matches
    FROM handyman_service_requests r LEFT JOIN handyman_channel_attributions a ON a.id=r.channel_attribution_id
    WHERE r.id=$1`, [id])).rows[0];
  if (!row) throw AppError.notFound('Handyman Request not found.');
  return row;
}

// Include inconsistent cross-links in the candidate set so they block instead
// of disappearing through an inner join. Rework is never an original member.
const candidateWhere = `s.scope_kind='ORIGINAL' AND (s.handyman_request_id=$1
  OR s.quotation_id IN (SELECT id FROM handyman_quotations WHERE handyman_request_id=$1)
  OR s.approved_quotation_version_id IN (SELECT v.id FROM handyman_quotation_versions v
    JOIN handyman_quotations q ON q.id=v.quotation_id WHERE q.handyman_request_id=$1)
  OR s.quotation_decision_id IN (SELECT d.id FROM handyman_quotation_decisions d
    LEFT JOIN handyman_quotations q ON q.id=d.quotation_id
    LEFT JOIN handyman_quotation_versions v ON v.id=d.quotation_version_id
    LEFT JOIN handyman_quotations vq ON vq.id=v.quotation_id
    WHERE q.handyman_request_id=$1 OR vq.handyman_request_id=$1))`;

async function approvalMatches(tx: PoolClient, request: RequestRow, v: Version, d: Decision, s: Scope): Promise<boolean> {
  if (d.client_id !== request.client_id || d.quotation_id !== v.quotation_id || d.quotation_version_id !== v.id ||
      d.decision !== 'APPROVE' || d.tenant_company_id !== request.tenant_company_id ||
      d.tenant_pic_id !== request.tenant_pic_id || s.created_by_user_id !== d.decided_by_user_id ||
      s.created_by_care_actor_id !== d.decided_by_care_actor_id) return false;
  const parts = [d.offer_document_id, d.offer_source_sha256, d.offer_pdf_sha256];
  if (parts.some(Boolean) && !parts.every(Boolean)) return false;
  const offer = d.offer_document_id ? { id: d.offer_document_id, sourceSha256: d.offer_source_sha256!, pdfSha256: d.offer_pdf_sha256! } : null;
  // Reuse the issuing engine's byte/snapshot verification. A modern offer
  // cannot be silently treated as an unbound historical approval.
  try {
    if (stableJson(await findQuotationDecisionOffer(tx,v.id)) !== stableJson(offer)) return false;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
  if (offer) {
    const doc = (await tx.query(`SELECT 1 FROM handyman_quotation_documents WHERE id=$1 AND quotation_id=$2
      AND quotation_version_id=$3 AND client_id=$4 AND request_id=$5 AND source_sha256=$6 AND pdf_sha256=$7`,
    [offer.id, v.quotation_id, v.id, request.client_id, request.id, offer.sourceSha256, offer.pdfSha256])).rowCount;
    if (!doc) return false;
  }
  const personal = quotationDecisionFingerprint(v.id, 'APPROVE', offer);
  if (d.decided_by_user_id) {
    if (d.decided_by_care_actor_id || d.commercial_consent_id || !request.tenant_pic_id ||
        d.request_fingerprint !== personal) return false;
    // PIC identity must still be provable, but current ACTIVE/occupancy is not
    // retroactively substituted for the original approval event.
    return Boolean((await tx.query(`SELECT 1 FROM tenant_pics WHERE id=$1 AND tenant_company_id=$2 AND user_id=$3 FOR SHARE`,
      [request.tenant_pic_id, request.tenant_company_id, d.decided_by_user_id])).rowCount);
  }
  if (!d.decided_by_care_actor_id || !d.commercial_consent_id ||
      d.request_fingerprint !== careQuotationDecisionFingerprint(personal, d.decided_by_care_actor_id, d.commercial_consent_id)) return false;
  const c = (await tx.query(`SELECT * FROM handyman_commercial_consent_receipts WHERE id=$1`, [d.commercial_consent_id])).rows[0];
  if (!c || c.care_actor_id !== d.decided_by_care_actor_id || c.client_id !== request.client_id ||
      c.handyman_request_id !== request.id || c.target_type !== 'QUOTATION_VERSION' || c.target_id !== v.id ||
      c.decision !== 'ACCEPT' || !c.assertion || digest(c.assertion) !== c.assertion_hash) return false;
  const target = quotationCommercialTarget(v.id, { id: request.id, clientId: request.client_id,
    tenantCompanyId: request.tenant_company_id, tenantPicId: request.tenant_pic_id,
    buildingId: request.building_id, spaceId: request.space_id }, offer);
  const a = parseCommercialConsentAssertion(c.assertion);
  if (!a || c.target_digest !== target.digest || a.targetType !== target.type || a.targetId !== v.id ||
      a.targetDigest !== target.digest || a.decision !== 'ACCEPT' || a.careActorId !== d.decided_by_care_actor_id ||
      a.clientId !== request.client_id || a.handymanRequestId !== request.id || a.tenantCompanyId !== request.tenant_company_id ||
      a.tenantPicId !== request.tenant_pic_id || a.buildingId !== request.building_id || a.spaceId !== request.space_id ||
      a.jti !== c.assertion_id || a.communicationId !== c.communication_id) return false;
  // The receipt is the immutable result of the signed-consent bridge; recheck
  // its immutable communication/actor binding without imposing today's expiry
  // or revocation on a historical customer approval.
  return Boolean((await tx.query(`SELECT 1 FROM handyman_care_communications comm
    JOIN handyman_handoff_care_actors actor ON actor.id=comm.recorded_by_care_actor_id
    WHERE comm.id=$1 AND comm.client_id=$2 AND comm.handyman_request_id=$3 AND comm.building_id=$4
      AND comm.recorded_by_care_actor_id=$5 AND actor.integration_id=$6
      AND comm.purpose='QUOTATION_RESPONSE_RECEIVED' AND comm.reported_statement='CONFIRM'`,
    [c.communication_id,request.client_id,request.id,request.building_id,d.decided_by_care_actor_id,c.integration_id])).rowCount);
}

/** A recorded QC review is not a current completion by itself. Only use the
 * existing current QC + manifest verifier; never use a generic Work Order or a
 * legacy CLOSED scope as proof of completion. */
async function completionAt(tx: PoolClient, s: Scope) {
  const review = (await tx.query<{ qc_run_id: string; manifest_id: string; manifest_version: number; manifest_sha256: string; items: unknown }>(`
    SELECT v.qc_run_id,v.manifest_id,v.manifest_version,v.manifest_sha256,m.source_snapshot->'items' AS items
    FROM handyman_completion_manifests m JOIN handyman_completion_verifications v ON v.manifest_id=m.id
    WHERE m.execution_scope_id=$1 AND m.version=(SELECT max(version) FROM handyman_completion_manifests WHERE execution_scope_id=$1)
    ORDER BY v.verified_at DESC,v.id DESC LIMIT 1`, [s.id])).rows[0];
  if (!review) return { status: 'NOT_VERIFIED' as const, workState: 'UNKNOWN' as const, manifestId: null, manifestVersion: null, manifestSha256: null, qcRunId: null };
  try {
    await assertCurrentGuardedHandymanQcPass(tx, { id:s.id, clientId:s.client_id, buildingId:s.building_id }, review.qc_run_id);
    const proof = await requireVerifiedCompletionForIssue(tx, { id:s.id, clientId:s.client_id, buildingId:s.building_id,
      handymanRequestId:s.handyman_request_id, status:s.status }, review.qc_run_id);
    if (proof.manifestId !== review.manifest_id || proof.manifestVersion !== review.manifest_version || proof.manifestSha256 !== review.manifest_sha256) throw changed();
    if (!Array.isArray(review.items) || !review.items.length || review.items.some(item =>
        !item || typeof item !== 'object' || !['COMPLETED','PARTIAL','NOT_PERFORMED'].includes(item.status))) throw changed();
    const workState = review.items.every(item=>item.status==='COMPLETED') ? 'COMPLETED' as const : 'INCOMPLETE' as const;
    return { status:'VERIFIED' as const, workState, manifestId:review.manifest_id, manifestVersion:review.manifest_version,
      manifestSha256:review.manifest_sha256, qcRunId:review.qc_run_id };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { status:'STALE_OR_UNVERIFIED' as const, workState:'UNKNOWN' as const, manifestId:review.manifest_id, manifestVersion:review.manifest_version,
      manifestSha256:review.manifest_sha256, qcRunId:review.qc_run_id };
  }
}

/**
 * Internal transaction-scoped authority. Caller must already authorize the
 * exact Request/Client/Building. It locks existing ORIGINAL scopes first,
 * then the revision fence, and rejects phantoms. The lock is held until the
 * caller's transaction ends. This is not Request-close readiness.
 */
export async function readHandymanRequestScopeSetInTransaction(tx: PoolClient, request: RequestRow) {
  const locked = (await tx.query<{id:string}>(`SELECT s.id FROM handyman_execution_scopes s WHERE ${candidateWhere} ORDER BY s.id FOR UPDATE`, [request.id])).rows.map(x=>x.id);
  const head = (await tx.query<{revision:string}>('SELECT revision::text FROM handyman_request_scope_set_revisions WHERE request_id=$1 FOR SHARE', [request.id])).rows[0];
  if (!head) throw new AppError({code:ERROR_CODES.CONFLICT,statusCode:409,message:'Request scope-set fence is missing.'});
  // requestAt ran before the fence. Re-read after taking it so a concurrent
  // cancellation/status change cannot produce an old request with a new pin.
  const currentRequest = await requestAt(tx,request.id);
  const requestFields: Array<keyof RequestRow> = ['id','client_id','building_id','tenant_company_id','tenant_pic_id',
    'space_id','channel_attribution_id','status','attribution_matches'];
  if (requestFields.some(field=>request[field]!==currentRequest[field])) throw changed();
  request=currentRequest;
  const scopes = (await tx.query<Scope>(`SELECT s.* FROM handyman_execution_scopes s WHERE ${candidateWhere} ORDER BY s.id`, [request.id])).rows;
  if (stableJson(locked) !== stableJson(scopes.map(s=>s.id))) throw changed();
  const quotations = (await tx.query(`SELECT id,client_id,handyman_request_id FROM handyman_quotations WHERE handyman_request_id=$1 ORDER BY id`, [request.id])).rows;
  const versions = (await tx.query<Version>(`SELECT v.id,v.quotation_id,v.version_number,v.status,v.valid_until
    FROM handyman_quotation_versions v JOIN handyman_quotations q ON q.id=v.quotation_id WHERE q.handyman_request_id=$1
    ORDER BY v.version_number,v.id`, [request.id])).rows;
  const decisions = (await tx.query<Decision>(`SELECT d.* FROM handyman_quotation_decisions d WHERE
    d.quotation_id IN (SELECT id FROM handyman_quotations WHERE handyman_request_id=$1)
    OR d.quotation_version_id IN (SELECT v.id FROM handyman_quotation_versions v JOIN handyman_quotations q ON q.id=v.quotation_id WHERE q.handyman_request_id=$1)
    ORDER BY d.id`, [request.id])).rows;
  const blockers: Blocker[] = [];
  const add = (code:string, message:string) => { if (!blockers.some(x=>x.code===code)) blockers.push(blocker(code,message)); };
  if (!request.attribution_matches) add('REQUEST_LINEAGE_INCONSISTENT','Request and original attribution do not match.');
  if (quotations.length > 1 || quotations.some(q=>q.client_id!==request.client_id)) add('QUOTATION_AMBIGUOUS','Request quotation lineage is inconsistent.');
  if (request.status==='CANCELLED' && scopes.length) add('CANCELLED_REQUEST_HAS_SCOPES','A cancelled Request has original scopes; manual resolution is required.');
  const quotationId = quotations.length===1 && quotations[0].client_id===request.client_id ? String(quotations[0].id) : null;
  const members: Array<{executionScopeId:string; clientId:string; buildingId:string; requestId:string; tenantCompanyId:string;
    quotationId:string; approvalVersionId:string; approvalVersionNumber:number; approvalDecisionId:string;
    scopeStatus:string; completion:Awaited<ReturnType<typeof completionAt>>}> = [];
  const versionIds=new Set<string>(), decisionIds=new Set<string>();
  for (const s of scopes) {
    const version=versions.find(v=>v.id===s.approved_quotation_version_id);
    const decision=decisions.find(d=>d.id===s.quotation_decision_id);
    if (versionIds.has(s.approved_quotation_version_id) || decisionIds.has(s.quotation_decision_id)) {
      add('DUPLICATE_SCOPE_LINK','An approval is linked to more than one original scope.'); continue;
    }
    versionIds.add(s.approved_quotation_version_id); decisionIds.add(s.quotation_decision_id);
    if (!quotationId || s.handyman_request_id!==request.id || s.client_id!==request.client_id || s.building_id!==request.building_id ||
        s.tenant_company_id!==request.tenant_company_id || s.tenant_pic_id!==request.tenant_pic_id || s.space_id!==request.space_id ||
        s.channel_attribution_id!==request.channel_attribution_id || s.quotation_id!==quotationId || !version ||
        version.quotation_id!==quotationId || version.status!=='APPROVED' || !decision || !['AUTHORIZED','CLOSED'].includes(s.status) ||
        !(await approvalMatches(tx,request,version,decision,s))) {
      add('SCOPE_APPROVAL_INCONSISTENT','An original scope has missing, stale, ambiguous or cross-context approval lineage.'); continue;
    }
    members.push({executionScopeId:s.id,clientId:s.client_id,buildingId:s.building_id,requestId:request.id,
      tenantCompanyId:s.tenant_company_id,quotationId,approvalVersionId:version.id,approvalVersionNumber:version.version_number,
      approvalDecisionId:decision.id,scopeStatus:s.status,completion:await completionAt(tx,s)});
  }
  for (const v of versions) {
    const ds=decisions.filter(d=>d.quotation_version_id===v.id);
    const ss=scopes.filter(s=>s.approved_quotation_version_id===v.id);
    if (ds.length>1 || ss.length>1) add('DUPLICATE_SCOPE_LINK','An approval is linked to more than one original scope.');
    if ((v.status==='APPROVED' || ds.some(d=>d.decision==='APPROVE')) &&
        (v.status!=='APPROVED' || ds.length!==1 || ds[0].decision!=='APPROVE' || ss.length!==1 ||
         !members.some(m=>m.executionScopeId===ss[0]?.id)))
      add('APPROVAL_WITHOUT_VERIFIED_SCOPE','An approved version lacks one exact verified original scope.');
    if (v.status==='REJECTED' && (ds.length!==1 || ds[0].decision!=='REJECT'))
      add('STALE_QUOTATION_DECISION','A quotation decision does not match its version lifecycle.');
    if (ds.some(d=>d.quotation_id!==quotationId || d.client_id!==request.client_id ||
        d.tenant_company_id!==request.tenant_company_id || d.tenant_pic_id!==request.tenant_pic_id) ||
        (v.status!=='APPROVED' && v.status!=='REJECTED' && ds.length))
      add('STALE_QUOTATION_DECISION','A quotation decision does not match its Request or version lifecycle.');
  }
  if (decisions.some(d=>!versions.some(v=>v.id===d.quotation_version_id)))
    add('STALE_QUOTATION_DECISION','A decision is not bound to a version of this Request quotation.');
  if (!members.length) add('NO_APPROVED_ORIGINAL_SCOPE','No verified approved original scope exists for this Request.');
  const quotationVersions=versions.map(v=>({id:v.id,versionNumber:v.version_number,status:v.status,
    decision:decisions.find(d=>d.quotation_version_id===v.id)?.decision ?? null}));
  // Stable deterministic digest covers the exact raw approval/scope identities
  // too, including blocked rows. It is a snapshot pin, never a closure fact.
  const snapshot = {protocol:'HANDYMAN_REQUEST_SCOPE_SET_V1', requestId:request.id, clientId:request.client_id,
    buildingId:request.building_id, tenantCompanyId:request.tenant_company_id, requestStatus:request.status,
    revision:head.revision, quotationId, scopes:members, quotationVersions, blockers,
    rawScopes:scopes.map(s=>({id:s.id,clientId:s.client_id,buildingId:s.building_id,requestId:s.handyman_request_id,
      quotationId:s.quotation_id,versionId:s.approved_quotation_version_id,decisionId:s.quotation_decision_id,status:s.status})),
    rawDecisions:decisions.map(d=>({id:d.id,clientId:d.client_id,quotationId:d.quotation_id,versionId:d.quotation_version_id,
      decision:d.decision,fingerprint:d.request_fingerprint})) };
  return { protocol:snapshot.protocol, requestId:request.id, clientId:request.client_id, buildingId:request.building_id,
    tenantCompanyId:request.tenant_company_id, requestStatus:request.status, revision:head.revision,
    fingerprint:digest(snapshot), membershipStatus:blockers.length ? 'BLOCKED' as const : 'ESTABLISHED' as const,
    scopes:members, quotationVersions, blockers };
}

/** Authenticated, exact-Building Operations read. No memberships or CLOSE are written. */
export async function getHandymanRequestScopeSet(requestInput: unknown, actorInput: string) {
  const requestId=uuid(requestInput), actor=uuid(actorInput);
  return withTransaction(async tx=>{
    const request=await requestAt(tx,requestId);
    await assertBuildingScopedResourceAccess(actor,{clientId:request.client_id,buildingId:request.building_id},tx);
    const user=(await tx.query('SELECT status FROM users WHERE id=$1 FOR SHARE',[actor])).rows[0];
    if (user?.status!=='ACTIVE') throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'Active Operations authority is required.'});
    await assertHandymanQuotationPricingAuthority({clientId:request.client_id,handymanRequestId:request.id,
      tenantCompanyId:request.tenant_company_id,actorUserId:actor},tx);
    return readHandymanRequestScopeSetInTransaction(tx,request);
  });
}

/** Future CLOSE consumers must call in their own transaction, hold the locks,
 * compare BOTH pins and separately recheck all non-membership readiness gates. */
export async function assertHandymanRequestScopeSetCurrent(tx: PoolClient, requestId: string,
  expected: { revision:string; fingerprint:string }) {
  const request=await requestAt(tx,uuid(requestId));
  const result=await readHandymanRequestScopeSetInTransaction(tx,request);
  if (result.membershipStatus!=='ESTABLISHED' || result.revision!==expected.revision || result.fingerprint!==expected.fingerprint) throw changed();
  return result;
}
