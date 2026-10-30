import type { PoolClient } from 'pg';
import { permissionDeniedError } from '../auth/auth.errors';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { permissionRepository } from '../permissions';
import { handymanExecutionScopeRepository } from '../handyman-quotations/handyman-execution-scope.repository';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations/handyman-execution-scope.service';
import { assertHandymanTenantDecisionActor } from './handyman-tenant-decision-authority';

/**
 * PART 04: personal customer decisions on an existing Work Order reuse the
 * PART 03 trust root. No staff, Owner, recorder or unverified-delegate fallback.
 * Caller owns the transaction; PIC/account share locks survive its mutations.
 * Closed scopes remain usable for the existing customer warranty decisions;
 * each command's own lifecycle still determines whether it can mutate.
 */
export async function assertHandymanCustomerScopeAuthority(
  tx: PoolClient,
  executionScopeId: string,
  actorUserId: string,
) {
  const scope = await handymanExecutionScopeRepository.findScopeById(tx, executionScopeId);
  if (!scope) throw handymanExecutionScopeNotFoundError();
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId, buildingId: scope.buildingId,
  }, tx);
  const permissions = await permissionRepository.listActivePermissionCodesForUser(actorUserId, tx);
  if (!permissions.includes('tenant_company.manage')) throw permissionDeniedError();
  const authority = await assertHandymanTenantDecisionActor(tx, {
    actorUserId, handymanRequestId: scope.handymanRequestId,
    clientId: scope.clientId, tenantCompanyId: scope.tenantCompanyId,
    buildingId: scope.buildingId,
  });
  if (scope.tenantPicId !== authority.tenantPicId) throw permissionDeniedError();
  return { scope, tenantPicId: authority.tenantPicId };
}
