import type { PoolClient } from 'pg';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { assertHandymanQuotationPricingAuthority } from '../handyman-quotations/handyman-quotation-access';
import { handymanServiceWarrantyReworkNotAuthorizedError } from './handyman-service-warranty-rework.errors';

/** Existing documented Operations authority, held through the rework mutation. */
export async function assertWarrantyReworkOperations(tx:PoolClient, scope:{clientId:string;buildingId:string;handymanRequestId:string}, actor:string):Promise<void> {
  await assertBuildingScopedResourceAccess(actor,{clientId:scope.clientId,buildingId:scope.buildingId},tx);
  await assertHandymanQuotationPricingAuthority({clientId:scope.clientId,handymanRequestId:scope.handymanRequestId,actorUserId:actor},tx);
  const held=await tx.query<{code:string}>(`SELECT perm.code FROM users u
    JOIN user_building_assignments uba ON uba.user_id=u.id AND uba.building_id=$2 AND uba.status='ACTIVE'
    JOIN buildings b ON b.id=uba.building_id AND b.status='ACTIVE'
    JOIN properties pr ON pr.id=b.property_id AND pr.client_id=$3
    JOIN user_role_assignments ura ON ura.user_id=u.id AND ura.status='ACTIVE'
    JOIN roles r ON r.id=ura.role_id AND r.status='ACTIVE'
    JOIN role_permission_assignments rpa ON rpa.role_id=r.id AND rpa.status='ACTIVE'
    JOIN permissions perm ON perm.id=rpa.permission_id AND perm.status='ACTIVE'
    WHERE u.id=$1 AND u.status='ACTIVE' AND perm.code IN ('tenant_company.manage','handyman.commercial.manage')
    FOR SHARE OF u,uba,b,pr,ura,r,rpa,perm`, [actor,scope.buildingId,scope.clientId]);
  if (new Set(held.rows.map(row=>row.code)).size!==2) throw handymanServiceWarrantyReworkNotAuthorizedError();
}
