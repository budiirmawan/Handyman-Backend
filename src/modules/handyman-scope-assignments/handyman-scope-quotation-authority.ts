import type { PoolClient } from 'pg';
import { readCoveredWarrantyClaimApproval } from '../handyman-service-warranty-claims/handyman-warranty-claim-assessment.service';

/**
 * A scope's individual foreign keys do not prove that its decision, version,
 * quotation and request belong together. Re-prove the immutable approval
 * lineage before assigning or dispatching, and hold the version projection
 * stable through the caller's transaction. The decision itself remains the
 * existing authenticated-PIC / verified-consent authority; this does not
 * create or reinterpret a tenant decision.
 */
export async function hasApprovedScopeQuotation(
  db: PoolClient,
  scopeId: string,
): Promise<boolean> {
  // A rework is authorized by the approved, certificate-bound claim, not
  // by attributing the customer's earlier quotation decision to Operations.
  const child = (await db.query<{original_scope_id:string; claim_id:string; current:boolean}>(
    `SELECT x.original_scope_id,x.claim_id,hm_warranty_rework_scope_current(x.execution_scope_id) AS current
       FROM handyman_warranty_rework_executions x WHERE x.execution_scope_id=$1`, [scopeId])).rows[0];
  if (child) return child.current && !!(await readCoveredWarrantyClaimApproval(db, child.claim_id))
    && await hasApprovedScopeQuotation(db, child.original_scope_id);
  const result = await db.query(
    `SELECT v.id
       FROM handyman_execution_scopes s
       JOIN handyman_service_requests r
         ON r.id = s.handyman_request_id AND r.client_id = s.client_id
        AND r.channel_attribution_id = s.channel_attribution_id
        AND r.tenant_company_id = s.tenant_company_id
        AND r.tenant_pic_id IS NOT DISTINCT FROM s.tenant_pic_id
        AND r.building_id = s.building_id
        AND r.space_id IS NOT DISTINCT FROM s.space_id
       JOIN handyman_quotations q
         ON q.id = s.quotation_id AND q.client_id = s.client_id
        AND q.handyman_request_id = s.handyman_request_id
       JOIN handyman_quotation_versions v
         ON v.id = s.approved_quotation_version_id AND v.quotation_id = q.id
       JOIN handyman_quotation_decisions d
         ON d.id = s.quotation_decision_id AND d.client_id = s.client_id
        AND d.quotation_id = q.id AND d.quotation_version_id = v.id
        AND d.tenant_company_id = s.tenant_company_id
        AND d.tenant_pic_id IS NOT DISTINCT FROM s.tenant_pic_id
      WHERE s.id = $1 AND v.status = 'APPROVED' AND d.decision = 'APPROVE'
        AND NOT EXISTS (SELECT 1 FROM handyman_inspection_fee_offers o WHERE o.quotation_version_id = v.id)
        AND (
          (d.decided_by_user_id IS NOT NULL AND d.tenant_pic_id IS NOT NULL
           AND d.decided_by_user_id = s.created_by_user_id
           AND d.decided_by_care_actor_id IS NULL AND d.commercial_consent_id IS NULL)
          OR
          (d.decided_by_care_actor_id IS NOT NULL
           AND d.decided_by_care_actor_id = s.created_by_care_actor_id
           AND d.decided_by_user_id IS NULL AND EXISTS (
             SELECT 1 FROM handyman_commercial_consent_receipts c
              WHERE c.id = d.commercial_consent_id
                AND c.care_actor_id = d.decided_by_care_actor_id
                AND c.client_id = s.client_id
                AND c.handyman_request_id = s.handyman_request_id
                AND c.target_type = 'QUOTATION_VERSION' AND c.target_id = v.id
                AND c.decision = 'ACCEPT'
           ))
        )
      FOR SHARE OF v`,
    [scopeId],
  );
  return result.rows.length === 1;
}
