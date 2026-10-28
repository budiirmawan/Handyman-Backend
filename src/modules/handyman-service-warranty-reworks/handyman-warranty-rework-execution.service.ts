import { randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { assertCurrentGuardedHandymanQcPass } from '../handyman-evidence-qc/handyman-qc-pass-gate';
import { isHandymanQcSupervisor } from '../handyman-evidence-qc/handyman-qc-authority';
import { assertWarrantyReworkOperations } from './handyman-warranty-rework-authority';
import { permissionRepository } from '../permissions';
import { resolveHandymanAssignmentLead } from '../handyman-scope-assignments';
import { hasApprovedScopeQuotation } from '../handyman-scope-assignments/handyman-scope-quotation-authority';
import { readCoveredWarrantyClaimApproval } from '../handyman-service-warranty-claims/handyman-warranty-claim-assessment.service';
import { handymanServiceWarrantyReworkRepository } from './handyman-service-warranty-rework.repository';
import { handymanServiceWarrantyReworkConflictError, handymanServiceWarrantyReworkNotFoundError,
  handymanServiceWarrantyReworkNotAuthorizedError, handymanServiceWarrantyReworkValidationError } from './handyman-service-warranty-rework.errors';

function uuid(value:string, field:string):string {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) throw handymanServiceWarrantyReworkValidationError(field);
  return value.trim();
}
function key(value:string):string {
  const s=typeof value==='string' ? value.trim() : '';
  if (!s || s.length>200) throw handymanServiceWarrantyReworkValidationError('idempotencyKey');
  return s;
}

/** Operations creates one child scope from the exact approved claim. No financial document is created. */
export async function createWarrantyReworkExecution(actorInput:string, reworkInput:string, keyInput:string) {
  const actor=uuid(actorInput,'actorUserId'), reworkId=uuid(reworkInput,'reworkId'), idem=key(keyInput);
  const existing=await handymanServiceWarrantyReworkRepository.findReworkById(getPool(),reworkId);
  if (!existing) throw handymanServiceWarrantyReworkNotFoundError();
  return withTransaction(async tx=>{
    const parent=(await tx.query<{id:string;client_id:string;building_id:string;handyman_request_id:string}>(
      'SELECT id,client_id,building_id,handyman_request_id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE',
      [existing.executionScopeId])).rows[0];
    if (!parent) throw handymanServiceWarrantyReworkNotFoundError();
    await assertWarrantyReworkOperations(tx,{clientId:parent.client_id,buildingId:parent.building_id,handymanRequestId:parent.handyman_request_id},actor);
    const rework=await handymanServiceWarrantyReworkRepository.findReworkById(tx,reworkId,true);
    if (!rework) throw handymanServiceWarrantyReworkNotFoundError();
    const prior=(await tx.query<{execution_scope_id:string;created_by_user_id:string;idempotency_key:string}>(
      'SELECT execution_scope_id,created_by_user_id,idempotency_key FROM handyman_warranty_rework_executions WHERE rework_id=$1',[reworkId])).rows[0];
    if (prior) {
      if (prior.created_by_user_id!==actor || prior.idempotency_key!==idem)
        throw handymanServiceWarrantyReworkConflictError('rework-execution-already-exists');
      return {executionScopeId:prior.execution_scope_id,reworkId,replayed:true};
    }
    if (rework.status!=='REWORK_AUTHORIZED' || !(await readCoveredWarrantyClaimApproval(tx,rework.claimId)) ||
        !(await hasApprovedScopeQuotation(tx,parent.id)))
      throw handymanServiceWarrantyReworkConflictError('current-approved-claim-and-original-authority-required');
    const id=randomUUID();
    await tx.query(`INSERT INTO handyman_execution_scopes
      (id,client_id,handyman_request_id,channel_attribution_id,quotation_id,approved_quotation_version_id,
       quotation_decision_id,tenant_company_id,tenant_pic_id,building_id,floor_id,area_id,room_id,space_id,
       status,created_by_user_id,created_by_care_actor_id,scope_kind,warranty_rework_id,warranty_rework_key)
      SELECT $1,client_id,handyman_request_id,channel_attribution_id,quotation_id,approved_quotation_version_id,
       quotation_decision_id,tenant_company_id,tenant_pic_id,building_id,floor_id,area_id,room_id,space_id,
       'AUTHORIZED',$2,NULL,'WARRANTY_REWORK',$3,$4 FROM handyman_execution_scopes WHERE id=$5 AND scope_kind='ORIGINAL'`,
    [id,actor,reworkId,idem,parent.id]);
    return {executionScopeId:id,reworkId,replayed:false};
  });
}

/** Read-only handoff for subsequent resolution; it never resolves the claim. */
export async function readWarrantyReworkExecution(actorInput:string,reworkInput:string,qcInput?:string) {
  const actor=uuid(actorInput,'actorUserId'), reworkId=uuid(reworkInput,'reworkId');
  const expectedQc=qcInput ? uuid(qcInput,'qcRunId') : undefined;
  return withTransaction(async tx=>{
    const row=(await tx.query<{execution_scope_id:string;original_scope_id:string;claim_id:string;assessment_id:string;
      certificate_id:string;item_line_id:string;coverage_kind:string;client_id:string;building_id:string;tenant_company_id:string;
      status:string;completion_id:string|null;session_id:string|null;lead_user_id:string|null;evidence_reference:string|null;
      evidence_sha256:string|null;completed_at:Date|null}>(`SELECT x.execution_scope_id,x.original_scope_id,x.claim_id,x.assessment_id,
        x.certificate_id,x.item_line_id,x.coverage_kind,x.client_id,x.building_id,s.tenant_company_id,r.status,
        c.id AS completion_id,c.session_id,c.lead_user_id,u.attachment_reference AS evidence_reference,c.evidence_sha256,c.completed_at
      FROM handyman_warranty_rework_executions x JOIN handyman_execution_scopes s ON s.id=x.execution_scope_id
      JOIN handyman_service_warranty_reworks r ON r.id=x.rework_id
      LEFT JOIN handyman_warranty_rework_completions c ON c.rework_id=r.id
      LEFT JOIN handyman_field_evidence_uploads u ON u.id=c.evidence_upload_id WHERE x.rework_id=$1`,[reworkId])).rows[0];
    if (!row) throw handymanServiceWarrantyReworkNotFoundError();
    await assertBuildingScopedResourceAccess(actor,{clientId:row.client_id,buildingId:row.building_id},tx);
    // Lock in parent -> child order, matching source correction and QC writers.
    await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR SHARE',[row.original_scope_id]);
    await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE',[row.execution_scope_id]);
    const pics=await tx.query<{tenant_company_id:string}>(
      `SELECT tenant_company_id FROM tenant_pics WHERE user_id=$1 AND status='ACTIVE'`,[actor]);
    if (pics.rows.length && !pics.rows.some(pic=>pic.tenant_company_id===row.tenant_company_id))
      throw handymanServiceWarrantyReworkNotAuthorizedError();
    const permissions=await permissionRepository.listActivePermissionCodesForUser(actor,tx);
    if (!permissions.includes('tenant_company.read') && !permissions.includes('handyman.warranty.assess')) {
      const lead=await resolveHandymanAssignmentLead(row.execution_scope_id,actor,tx).catch(()=>null);
      if (lead?.leadUserId!==actor && !(await isHandymanQcSupervisor(row.execution_scope_id,row.client_id,actor,tx)))
        throw handymanServiceWarrantyReworkNotAuthorizedError();
    }
    if (!(await readCoveredWarrantyClaimApproval(tx,row.claim_id)))
      throw handymanServiceWarrantyReworkConflictError('current-covered-assessment-required');
    const latest=(await tx.query<{id:string;status:string;version:number}>(`SELECT id,status,version FROM handyman_qc_runs
      WHERE execution_scope_id=$1 AND client_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [row.execution_scope_id,row.client_id])).rows[0];
    if (expectedQc && (!latest || latest.id!==expectedQc || latest.status!=='PASSED'))
      throw handymanServiceWarrantyReworkConflictError('qc-run-not-current-passed-rework');
    let qc=null;
    if (latest?.status==='PASSED') {
      const pass=await assertCurrentGuardedHandymanQcPass(tx,{id:row.execution_scope_id,clientId:row.client_id,buildingId:row.building_id},expectedQc);
      qc={runId:pass.runId,version:latest.version,status:'PASSED',templateVersionId:pass.templateVersionId};
    } else if (latest) qc={runId:latest.id,version:latest.version,status:latest.status,templateVersionId:null};
    return {reworkId,executionScopeId:row.execution_scope_id,originalScopeId:row.original_scope_id,claimId:row.claim_id,
      assessmentId:row.assessment_id,certificateId:row.certificate_id,itemLineId:row.item_line_id,coverageKind:row.coverage_kind,
      clientId:row.client_id,buildingId:row.building_id,tenantCompanyId:row.tenant_company_id,status:row.status,
      completion:row.completion_id ? {id:row.completion_id,sessionId:row.session_id,leadUserId:row.lead_user_id,
        evidenceReference:row.evidence_reference,evidenceSha256:row.evidence_sha256,completedAt:row.completed_at?.toISOString()} : null,
      qc,claimResolved:false};
  });
}
