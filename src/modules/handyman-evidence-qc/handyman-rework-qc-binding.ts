import type { PoolClient } from 'pg';
import { assertVerifiedManagedEvidenceReference } from '../handyman-field-evidence/handyman-field-evidence.service';
import { resolveHandymanAssignmentLead } from '../handyman-scope-assignments';
import { readCoveredWarrantyClaimApproval } from '../handyman-service-warranty-claims/handyman-warranty-claim-assessment.service';
import { handymanQcPassBlockedError } from './handyman-evidence-qc.errors';

/** Additional rework proof only; ordinary QC retains all its existing gates. */
export async function assertReworkQcBinding(tx:PoolClient,scopeId:string,runId:string):Promise<void> {
  const kind=(await tx.query<{scope_kind:string}>('SELECT scope_kind FROM handyman_execution_scopes WHERE id=$1',[scopeId])).rows[0];
  if (kind?.scope_kind!=='WARRANTY_REWORK') return;
  const row=(await tx.query<{claim_id:string;lead_user_id:string;assignment_id:string;evidence_reference:string;
    evidence_sha256:string;client_id:string;building_id:string;handyman_request_id:string}>(`SELECT x.claim_id,c.lead_user_id,c.assignment_id,
      u.attachment_reference AS evidence_reference,c.evidence_sha256,s.client_id,s.building_id,s.handyman_request_id
    FROM handyman_warranty_rework_qc_bindings b JOIN handyman_qc_runs q ON q.id=b.qc_run_id AND q.execution_scope_id=b.execution_scope_id
    JOIN handyman_warranty_rework_completions c ON c.id=b.completion_id AND c.execution_scope_id=b.execution_scope_id
    JOIN handyman_warranty_rework_executions x ON x.execution_scope_id=c.execution_scope_id AND x.rework_id=c.rework_id
    JOIN handyman_service_warranty_reworks r ON r.id=x.rework_id AND r.status='REWORK_COMPLETE'
    JOIN handyman_execution_scopes s ON s.id=x.execution_scope_id
    JOIN handyman_execution_scope_assignments a ON a.id=c.assignment_id AND a.execution_scope_id=s.id AND a.status='ACTIVE'
    JOIN handyman_arrival_verification_results ar ON ar.id=c.arrival_result_id AND ar.execution_scope_id=s.id
      AND ar.assignment_id=a.id AND ar.actor_user_id=c.lead_user_id AND ar.status='VERIFIED'
      AND ar.evaluated_at>=a.assigned_at AND ar.evaluated_at<=r.started_at
    JOIN handyman_field_evidence_uploads u ON u.id=c.evidence_upload_id AND u.execution_scope_id=s.id
      AND u.client_id=s.client_id AND u.building_id=s.building_id AND u.handyman_request_id=s.handyman_request_id
      AND u.uploaded_by_user_id=c.lead_user_id AND u.uploaded_by_role='PIC_PEKERJAAN' AND u.purpose='BEFORE_AFTER_WORK'
      AND u.upload_status='VERIFIED' AND u.verified_byte_size>0 AND u.sha256_checksum=c.evidence_sha256
      AND u.verified_at>=r.started_at
    WHERE b.qc_run_id=$1 AND b.execution_scope_id=$2 AND q.created_at>=c.completed_at
      AND NOT EXISTS (SELECT 1 FROM handyman_assignment_responses resp WHERE resp.assignment_id=a.id
        AND resp.assignment_target_type='EXECUTION_SCOPE_ASSIGNMENT' AND resp.response_status='TIDAK_BISA')
      AND hm_warranty_rework_scope_current(s.id)`,[runId,scopeId])).rows[0];
  if (!row || !(await readCoveredWarrantyClaimApproval(tx,row.claim_id)))
    throw handymanQcPassBlockedError('rework completion or current covered assessment is missing');
  const lead=await resolveHandymanAssignmentLead(scopeId,row.lead_user_id,tx);
  if (!lead || lead.assignmentId!==row.assignment_id || lead.leadUserId!==row.lead_user_id)
    throw handymanQcPassBlockedError('rework completion no longer matches the assigned Lead');
  const evidence=await assertVerifiedManagedEvidenceReference(tx,{
    clientId:row.client_id,buildingId:row.building_id,handymanRequestId:row.handyman_request_id,executionScopeId:scopeId,
  },row.evidence_reference,{requiredPurpose:'BEFORE_AFTER_WORK'});
  if (!evidence || evidence.sha256Checksum!==row.evidence_sha256)
    throw handymanQcPassBlockedError('rework completion bytes do not match');
}
