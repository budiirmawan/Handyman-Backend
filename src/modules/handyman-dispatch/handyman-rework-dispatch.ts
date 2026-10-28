import type { PoolClient } from 'pg';
import { readCoveredWarrantyClaimApproval } from '../handyman-service-warranty-claims/handyman-warranty-claim-assessment.service';

/** Take request → original scope before the child scope, matching appointment writes. */
export async function lockReworkDispatchLineage(tx:PoolClient,scopeId:string):Promise<void> {
  const row=(await tx.query<{request_id:string;original_scope_id:string}>(`SELECT s.handyman_request_id AS request_id,x.original_scope_id
    FROM handyman_warranty_rework_executions x JOIN handyman_execution_scopes s ON s.id=x.execution_scope_id
    WHERE x.execution_scope_id=$1`,[scopeId])).rows[0];
  if (!row) return;
  await tx.query('SELECT id FROM handyman_service_requests WHERE id=$1 FOR SHARE',[row.request_id]);
  await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE',[row.original_scope_id]);
}

/** No invoice, ledger or payment is created: the exemption derives only from the exact current covered claim. */
export async function readReworkDispatchBasis(tx:PoolClient,scopeId:string):Promise<{isRework:boolean;covered:boolean}> {
  const row=(await tx.query<{scope_kind:string;claim_id:string|null;current:boolean;noncommercial:boolean}>(`
    SELECT s.scope_kind,x.claim_id,
      COALESCE(hm_warranty_rework_scope_current(s.id),false) AS current,
      NOT EXISTS (SELECT 1 FROM handyman_customer_transactions t WHERE t.execution_scope_id=s.id) AS noncommercial
    FROM handyman_execution_scopes s LEFT JOIN handyman_warranty_rework_executions x ON x.execution_scope_id=s.id
      AND x.client_id=s.client_id AND x.building_id=s.building_id AND x.rework_id=s.warranty_rework_id
    WHERE s.id=$1`,[scopeId])).rows[0];
  if (!row || row.scope_kind!=='WARRANTY_REWORK') return {isRework:false,covered:false};
  return {isRework:true,covered:!!(row.current && row.noncommercial && row.claim_id &&
    await readCoveredWarrantyClaimApproval(tx,row.claim_id))};
}
