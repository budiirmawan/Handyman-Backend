import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { recordOperationalEvent } from '../operational-events';
import { handymanServiceRequestRepository as requests } from '../handyman-requests/handyman-service-request.repository';
import { handymanQuotationLineRepository as lines } from '../handyman-quotations/handyman-quotation-line.repository';
import { withCareWorkspaceSession, workspaceUnauthorized, type CareWorkspacePrincipal } from './care-workspace.service';
import { WORKSPACE_OCCUPANCY_CTES } from './care-workspace-occupancies.repository';
import { assistanceObject, assistanceSelection, assistanceUuid, assistanceWrite, careQuoteConflict, careQuoteNotFound, residentChannel } from './care-quotation.validation';

/** Issue-time delivery is workspace availability, NOT a resident message. */
export async function deliverQuotationToCare(tx: PoolClient, versionId: string, actorUserId: string, clientId: string) {
  await tx.query(`INSERT INTO handyman_care_quotation_deliveries(quotation_version_id,delivered_by_user_id) VALUES ($1,$2)`, [versionId,actorUserId]);
  await recordOperationalEvent({ clientId, entityType:'HANDYMAN_QUOTATION_VERSION', entityId:versionId,
    actorUserId, eventType:'HANDYMAN_QUOTATION_DELIVERED_TO_CARE', summary:'Issued quotation is available in the BM Customer Care workspace.',
    metadata:{ quotationVersionId:versionId, deliveryChannel:'BM_CARE_WORKSPACE', directResidentMessaging:false } }, tx);
}

export async function listCareQuotationInbox(token: string, query: unknown, body?: unknown) {
  if (body !== undefined) assistanceObject(body, []);
  const s = assistanceSelection(query,true);
  return withCareWorkspaceSession(token, async (tx, principal) => {
    const result = await tx.query(`${WORKSPACE_OCCUPANCY_CTES}, page AS (
      SELECT v.id AS "quotationVersionId",q.handyman_request_id AS "handymanRequestId",v.version_number AS "versionNumber",
        'BM_CARE_WORKSPACE' AS "deliveryChannel",v.valid_until AS "validUntil",d.delivered_at AS "deliveredAt",d.delivered_by_user_id AS "deliveredByUserId",
        ic.channel AS "residentIntakeChannel",
        CASE WHEN EXISTS(SELECT 1 FROM handyman_care_quotation_presentations p WHERE p.quotation_version_id=v.id)
          THEN 'PRESENTED' ELSE 'AVAILABLE_TO_CARE' END AS "presentationStatus"
      FROM handyman_quotation_versions v JOIN handyman_quotations q ON q.id=v.quotation_id
      JOIN handyman_service_requests r ON r.id=q.handyman_request_id
      LEFT JOIN handyman_care_quotation_deliveries d ON d.quotation_version_id=v.id
      LEFT JOIN handyman_care_intake_channels ic ON ic.handyman_request_id=r.id
      WHERE v.status='ISSUED' AND v.valid_until>clock_timestamp() AND ($5::uuid IS NULL OR v.id>$5)
        AND EXISTS(SELECT 1 FROM records c WHERE c."clientId"=r.client_id AND c."tenantCompanyId"=r.tenant_company_id
          AND c."buildingId"=r.building_id AND c."spaceId" IS NOT DISTINCT FROM r.space_id)
      ORDER BY v.id LIMIT $6
    ) SELECT EXISTS(SELECT 1 FROM authority) AS authenticated, EXISTS(SELECT 1 FROM records) AS accessible,
      COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page."quotationVersionId") FROM page),'[]'::jsonb) AS items`,
      [principal.sessionId,principal.careActorId,principal.integrationId,s.propertyId,s.afterVersionId,s.limit+1,s.tenantCompanyId,s.buildingId,s.spaceId]);
    const row=result.rows[0];
    if (!row.authenticated) throw workspaceUnauthorized();
    if (!row.accessible) throw careQuoteNotFound();
    const items=row.items.slice(0,s.limit);
    return { items, nextAfterVersionId:row.items.length>s.limit ? items[items.length-1].quotationVersionId : null,
      communicationAuthority:'BM_CUSTOMER_CARE', directResidentMessaging:false };
  });
}

async function scopedVersion(tx: PoolClient, principal: CareWorkspacePrincipal, requestId: string, versionId: string,
  selection: ReturnType<typeof assistanceSelection>, actionable: boolean) {
  // Hold the existing grant/hierarchy authority during mutations. Never use a
  // cached Client-wide grant or caller-shaped request context.
  await tx.query(`SELECT g.id FROM handyman_care_property_grants g JOIN properties p ON p.id=g.property_id
    JOIN buildings b ON b.property_id=p.id JOIN clients c ON c.id=p.client_id
    WHERE g.care_actor_id=$1 AND p.id=$2 AND b.id=$3 FOR SHARE OF g,p,b,c`,
    [principal.careActorId,selection.propertyId,selection.buildingId]);
  await tx.query(`SELECT t.id FROM tenant_companies t JOIN tenant_building_contexts bc ON bc.tenant_company_id=t.id
    WHERE t.id=$1 AND bc.building_id=$2 FOR SHARE OF t,bc`,[selection.tenantCompanyId,selection.buildingId]);
  await tx.query(`SELECT sr.id FROM tenant_space_relationships sr WHERE sr.tenant_company_id=$1 AND sr.building_id=$2 FOR SHARE`,[selection.tenantCompanyId,selection.buildingId]);
  const projection=await requests.findWorkspaceProjectionById(principal,requestId,selection,tx);
  if (!projection.authenticated) throw workspaceUnauthorized();
  if (!projection.item) throw careQuoteNotFound();
  if (projection.item.spaceId) {
    await tx.query(`SELECT s.id FROM spaces s JOIN rooms r ON r.id=s.room_id JOIN areas a ON a.id=r.area_id
      JOIN floors f ON f.id=a.floor_id WHERE s.id=$1 FOR SHARE OF s,r,a,f`,[projection.item.spaceId]);
    // The hierarchy could have changed while the lock was being acquired.
    const current=await requests.findWorkspaceProjectionById(principal,requestId,selection,tx);
    if (!current.item) throw careQuoteNotFound();
  }
  const result=await tx.query(`SELECT v.*, q.client_id, q.handyman_request_id FROM handyman_quotation_versions v
    JOIN handyman_quotations q ON q.id=v.quotation_id WHERE v.id=$1 AND q.handyman_request_id=$2 FOR SHARE OF v`,[versionId,requestId]);
  const v=result.rows[0];
  if (!v || v.status==='DRAFT') throw careQuoteNotFound();
  if (actionable) await requireCurrent(tx,versionId);
  return {version:v,request:projection.item};
}
async function requireCurrent(tx: PoolClient,versionId: string) {
  if (!(await tx.query("SELECT 1 FROM handyman_quotation_versions WHERE id=$1 AND status='ISSUED' AND valid_until>clock_timestamp()",[versionId])).rowCount) throw careQuoteConflict();
}

export async function getCareQuotation(token: string,requestInput: unknown,versionInput: unknown,query: unknown,body?: unknown) {
  if(body!==undefined) assistanceObject(body,[]);
  const requestId=assistanceUuid(requestInput), versionId=assistanceUuid(versionInput), selection=assistanceSelection(query);
  return withCareWorkspaceSession(token,async(tx,principal)=>{
    const {version}=await scopedVersion(tx,principal,requestId,versionId,selection,false);
    const commercial=await lines.listLines(tx,versionId);
    const totals=await lines.sumLines(tx,versionId);
    const presentations=await tx.query(`SELECT id,channel,care_actor_id AS "careActorId",presented_at AS "presentedAt"
      FROM handyman_care_quotation_presentations WHERE quotation_version_id=$1 ORDER BY presented_at,id`,[versionId]);
    const handoffs=await tx.query(`SELECT h.id,h.presentation_id AS "presentationId",h.approval_binding_id AS "approvalBindingId",
      h.care_actor_id AS "careActorId",p.channel,h.created_at AS "createdAt",h.expires_at AS "expiresAt",
      c.authenticated_at AS "picAuthenticatedAt",d.decision,
      CASE WHEN d.id IS NOT NULL THEN d.decision
        WHEN h.expires_at<=clock_timestamp() OR v.status<>'ISSUED' OR v.valid_until<=clock_timestamp()
          OR b.status<>'ACTIVE' OR b.effective_from>clock_timestamp() OR b.effective_until<=clock_timestamp() THEN 'STALE'
        WHEN c.handoff_id IS NOT NULL THEN 'PIC_AUTHENTICATED' ELSE 'PENDING_PIC_AUTHENTICATION' END AS status
      FROM handyman_care_quotation_handoffs h JOIN handyman_care_quotation_presentations p ON p.id=h.presentation_id
      JOIN handyman_quotation_versions v ON v.id=h.quotation_version_id JOIN handyman_quotation_approval_bindings b ON b.id=h.approval_binding_id
      LEFT JOIN handyman_care_quotation_pic_claims c ON c.handoff_id=h.id
      LEFT JOIN handyman_quotation_decisions d ON d.quotation_version_id=h.quotation_version_id
        AND d.decided_by_pic_session_id=c.pic_session_id AND d.approval_binding_id=h.approval_binding_id
      WHERE h.quotation_version_id=$1 ORDER BY h.created_at,h.id`,[versionId]);
    return {handymanRequestId:requestId,quotationVersionId:versionId,versionNumber:version.version_number,status:version.status,
      validUntil:version.valid_until, lines:commercial.map(l=>({id:l.id,lineType:l.lineType,description:l.description,quantity:l.quantity,
        uomId:l.uomId,finalQuotedUnitAmount:l.finalQuotedUnitAmount,lineTotal:l.lineTotal,currency:l.currency})),
      totals:{laborSubtotal:totals.labor,materialSubtotal:totals.material,total:totals.labor+totals.material,currency:commercial[0]?.currency??null},
      presentations:presentations.rows,handoffs:handoffs.rows,communicationAuthority:'BM_CUSTOMER_CARE',directResidentMessaging:false};
  });
}

export async function presentCareQuotation(token: string,requestInput: unknown,versionInput: unknown,query: unknown,body: unknown,key: unknown) {
  const input=assistanceObject(body,['channel']), channel=residentChannel(input.channel), idempotencyKey=assistanceUuid(key);
  const requestId=assistanceUuid(requestInput), versionId=assistanceUuid(versionInput),selection=assistanceSelection(query);
  return assistanceWrite(()=>withCareWorkspaceSession(token,async(tx,principal)=>{
    const {request}=await scopedVersion(tx,principal,requestId,versionId,selection,true);
    const id=randomUUID();
    const result=await tx.query(`INSERT INTO handyman_care_quotation_presentations(id,quotation_version_id,care_actor_id,care_session_id,channel,idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING presented_at AS "presentedAt"`,[id,versionId,principal.careActorId,principal.sessionId,channel,idempotencyKey]);
    await recordOperationalEvent({clientId:request.clientId,buildingId:request.buildingId,entityType:'HANDYMAN_QUOTATION_VERSION',entityId:versionId,
      eventType:'HANDYMAN_CARE_QUOTATION_PRESENTED',summary:'Customer Care recorded resident presentation of the issued quotation.',
      metadata:{presentationId:id,quotationVersionId:versionId,actorType:'CUSTOMER_CARE',careActorId:principal.careActorId,careSessionId:principal.sessionId,channel}},tx);
    return {id,quotationVersionId:versionId,status:'PRESENTED',channel,careActorId:principal.careActorId,...result.rows[0]};
  }));
}

export async function createCareQuotationHandoff(token: string,requestInput: unknown,versionInput: unknown,query: unknown,body: unknown) {
  const input=assistanceObject(body,['presentationId']),presentationId=assistanceUuid(input.presentationId);
  const requestId=assistanceUuid(requestInput), versionId=assistanceUuid(versionInput),selection=assistanceSelection(query);
  return assistanceWrite(()=>withCareWorkspaceSession(token,async(tx,principal)=>{
    const {request,version}=await scopedVersion(tx,principal,requestId,versionId,selection,true);
    const p=(await tx.query('SELECT * FROM handyman_care_quotation_presentations WHERE id=$1 AND quotation_version_id=$2',[presentationId,versionId])).rows[0];
    if(!p) throw careQuoteNotFound();
    const binding=(await tx.query(`SELECT * FROM handyman_quotation_approval_bindings WHERE quotation_id=$1 AND status='ACTIVE'
      AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()) FOR SHARE`,[version.quotation_id])).rows[0];
    if(!binding) throw careQuoteConflict();
    const id=randomUUID();
    const result=await tx.query(`INSERT INTO handyman_care_quotation_handoffs(id,presentation_id,quotation_version_id,approval_binding_id,care_actor_id,care_session_id,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,LEAST($7::timestamptz,clock_timestamp()+INTERVAL '10 minutes'))
      RETURNING created_at AS "createdAt",expires_at AS "expiresAt"`,[id,presentationId,versionId,binding.id,principal.careActorId,principal.sessionId,version.valid_until]);
    await recordOperationalEvent({clientId:request.clientId,buildingId:request.buildingId,entityType:'HANDYMAN_QUOTATION_VERSION',entityId:versionId,
      eventType:'HANDYMAN_CARE_PIC_HANDOFF_CREATED',summary:'Customer Care prepared a version-bound handoff requiring independent signed PIC authentication.',
      metadata:{handoffId:id,presentationId,quotationVersionId:versionId,approvalBindingId:binding.id,actorType:'CUSTOMER_CARE',careActorId:principal.careActorId,careSessionId:principal.sessionId,channel:p.channel}},tx);
    return {id,quotationVersionId:versionId,approvalBindingId:binding.id,status:'PENDING_PIC_AUTHENTICATION',channel:p.channel,
      careActorId:principal.careActorId,...result.rows[0],authenticationRequired:'SIGNED_TENANT_PIC_SESSION',
      picAdmissionPath:'/api/v1/handyman/pic/session',picClaimPath:`/api/v1/handyman/pic/quotation-handoffs/${id}/claim`,
      communicationAuthority:'BM_CUSTOMER_CARE',directResidentMessaging:false};
  }));
}
