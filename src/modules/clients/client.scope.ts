import { contextAccessService } from '../context-access';
import { PROTECTED_ROLE_CODE } from '../users/privileged-account.guard';
import { userRepository } from '../users/user.repository';
import type { ClientReadScope } from './client.types';

/**
 * CR-HM-BE-CLIENT-MASTER-01 — resolves the Client registry read reach for an
 * authenticated user.
 *
 * This is a data-scope decision layered on top of the existing canonical RBAC
 * gate (`client.read` / `client.manage`). It introduces NO new permission
 * code, NO role-name authority and NO user↔Client assignment table:
 *
 *   - `ALL` reuses the same protected-role precedent the Building assignment
 *     administration already applies (`assertActorCanManageBuilding`): the
 *     Owner (PLATFORM_ADMIN) administers the installation-wide registry;
 *   - `RESTRICTED` reuses the single BE-02G resolver
 *     (`contextAccessService.getAccessibleClientIds`), so Client visibility can
 *     never disagree with Building/data isolation.
 *
 * A brand-new Owner has zero Building assignments. That does NOT block the
 * first-Client bootstrap: the Owner resolves to `ALL`, Client creation needs
 * no pre-existing scope, and the 201 response already carries the authoritative
 * `data.id` for Property provisioning.
 *
 * This module is imported ONLY by the Client HTTP controller. Keeping it out
 * of `clients/index.ts` keeps the module graph acyclic
 * (context-access → building-assignments → clients/index).
 */
export async function resolveClientReadScope(
  userId: string,
): Promise<ClientReadScope> {
  if (await userRepository.hasActiveRole(userId, PROTECTED_ROLE_CODE)) {
    return { mode: 'ALL' };
  }

  return {
    mode: 'RESTRICTED',
    clientIds: await contextAccessService.getAccessibleClientIds(userId),
  };
}
