import type { PoolClient } from 'pg';
import { withPicWorkspaceSession, picWorkspaceResourceNotFound, type PicWorkspacePrincipal } from '../handyman-pic-session';
import { findVersionForCredential } from '../handyman-pic-portal/pic-portal.repository';
import { recordOperationalEvent } from '../operational-events';
import { assistanceUuid, assistanceWrite, careQuoteConflict } from './care-quotation.validation';

async function scopedHandoff(tx: PoolClient, principal: PicWorkspacePrincipal,id: string) {
  const result=await tx.query(`SELECT h.*,r.client_id,r.building_id FROM handyman_care_quotation_handoffs h
    JOIN handyman_quotation_versions v ON v.id=h.quotation_version_id JOIN handyman_quotations q ON q.id=v.quotation_id
    JOIN handyman_service_requests r ON r.id=q.handyman_request_id
    WHERE h.id=$1 AND r.tenant_company_id=$2 AND r.building_id=$3 AND ($4::uuid IS NULL OR r.space_id=$4)`,
    [id,principal.tenantCompanyId,principal.buildingId,principal.spaceId]);
  if(!result.rows[0]) throw picWorkspaceResourceNotFound();
  return result.rows[0];
}

/** An identifier locates a handoff; only the independent signed PIC session authenticates it. */
export async function resolveAssistedQuotationVersion(token: string,idInput: unknown) {
  const id=assistanceUuid(idInput);
  return withPicWorkspaceSession(token,async(tx,principal)=> (await scopedHandoff(tx,principal,id)).quotation_version_id as string);
}

export async function assertAssistedHandoff(tx: PoolClient,principal: PicWorkspacePrincipal,id: string,
  versionId: string,requireClaim: boolean,completedReplay=false) {
  const h=await scopedHandoff(tx,principal,id);
  if(!principal.canDecide || !principal.tenantPicId || h.quotation_version_id!==versionId) throw careQuoteConflict();
  const result=await tx.query(`SELECT h.id FROM handyman_care_quotation_handoffs h
    JOIN handyman_quotation_versions v ON v.id=h.quotation_version_id
    JOIN handyman_quotation_approval_bindings b ON b.id=h.approval_binding_id AND b.quotation_id=v.quotation_id
    WHERE h.id=$1 AND b.tenant_pic_id=$2 AND b.status='ACTIVE'
      AND ($4::boolean OR (h.expires_at>clock_timestamp() AND v.status='ISSUED' AND v.valid_until>clock_timestamp()
        AND b.effective_from<=clock_timestamp() AND (b.effective_until IS NULL OR b.effective_until>clock_timestamp())))
      AND (NOT $5::boolean OR EXISTS(SELECT 1 FROM handyman_care_quotation_pic_claims c WHERE c.handoff_id=h.id AND c.pic_session_id=$3))
    FOR SHARE OF b`,[id,principal.tenantPicId,principal.sessionId,completedReplay,requireClaim]);
  if(!result.rowCount) throw careQuoteConflict();
  return h;
}

export async function claimCareQuotationHandoff(token: string,idInput: unknown) {
  const id=assistanceUuid(idInput);
  return assistanceWrite(()=>withPicWorkspaceSession(token,async(tx,principal)=>{
    const scoped=await scopedHandoff(tx,principal,id);
    if(!await findVersionForCredential(tx,principal,scoped.quotation_version_id,{lock:'share'})) throw picWorkspaceResourceNotFound();
    const h=await assertAssistedHandoff(tx,principal,id,scoped.quotation_version_id,false);
    const result=await tx.query(`INSERT INTO handyman_care_quotation_pic_claims(handoff_id,pic_session_id) VALUES ($1,$2)
      RETURNING authenticated_at AS "authenticatedAt"`,[id,principal.sessionId]);
    await recordOperationalEvent({clientId:h.client_id,buildingId:h.building_id,entityType:'HANDYMAN_QUOTATION_VERSION',entityId:h.quotation_version_id,
      eventType:'HANDYMAN_CARE_HANDOFF_PIC_AUTHENTICATED',summary:'Independently authenticated Tenant PIC claimed the Customer Care quotation handoff.',
      metadata:{handoffId:id,quotationVersionId:h.quotation_version_id,approvalBindingId:h.approval_binding_id,actorType:'TENANT_PIC',tenantPicId:principal.tenantPicId,picSessionId:principal.sessionId}},tx);
    return {handoffId:id,quotationVersionId:h.quotation_version_id,status:'PIC_AUTHENTICATED',...result.rows[0],
      decisionPath:`/api/v1/handyman/pic/quotation-handoffs/${id}/decision`};
  }));
}
