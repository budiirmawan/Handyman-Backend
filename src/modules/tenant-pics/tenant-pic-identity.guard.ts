import type { PoolClient } from 'pg';
import { permissionDeniedError } from '../auth/auth.errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { permissionRepository } from '../permissions';
import type { TenantCompanyRecord } from '../tenant-companies';
import { userNotFoundError, userRepository } from '../users';
import {
  tenantCompanyInactiveForPicError,
  tenantPicUserAlreadyLinkedError,
  tenantPicUserClientMismatchError,
} from './tenant-pic.errors';
import type { TenantPicRecord } from './tenant-pic.types';

export type TenantPicIdentityAuthorization = {
  authority: 'IDENTITY_ADMIN' | 'SELF_UNLINK';
  buildingIds: string[];
};

/**
 * Identity changes are not contact maintenance. Existing user.manage AND
 * tenant_company.manage authorize administrative linking; a customer may only
 * unlink their own existing binding, never transfer it to another account.
 * No role label, contact email/phone, or caller-supplied identity is authority.
 * Called only after the company/PIC mutation locks, on the same transaction.
 */
export async function assertTenantPicIdentityChangeAuthorized(
  tx: PoolClient,
  company: TenantCompanyRecord,
  existing: TenantPicRecord | null,
  nextUserId: string | null,
  actorUserId: string,
): Promise<TenantPicIdentityAuthorization> {
  if (!actorUserId) throw permissionDeniedError();
  const actor = await userRepository.findById(actorUserId, tx);
  const permissions = await permissionRepository.listActivePermissionCodesForUser(actorUserId, tx);
  if (actor?.status !== 'ACTIVE' || !permissions.includes('tenant_company.manage')) {
    throw permissionDeniedError();
  }

  const selfUnlink = nextUserId === null && existing?.userId === actorUserId;
  if (!selfUnlink && !permissions.includes('user.manage')) {
    throw permissionDeniedError();
  }
  // Even an identity administrator cannot appoint themselves as a customer.
  if (nextUserId === actorUserId) throw permissionDeniedError();

  if (nextUserId !== null) {
    if (company.status !== 'ACTIVE') throw tenantCompanyInactiveForPicError();
    // Serialize all governed links to this account, including across different
    // companies. NO KEY UPDATE permits approval's FK KEY SHARE locks, avoiding
    // a PIC-lock / account-FK deadlock while preventing concurrent link races.
    const target = await tx.query<{ id: string; status: string }>(
      'SELECT id, status FROM users WHERE id = $1 FOR NO KEY UPDATE', [nextUserId],
    );
    if (!target.rows[0]) throw userNotFoundError();
    if (target.rows[0].status !== 'ACTIVE') throw permissionDeniedError();
    const links = await tx.query<{ id: string; tenant_company_id: string }>(
      'SELECT id, tenant_company_id FROM tenant_pics WHERE user_id = $1', [nextUserId],
    );
    if (links.rows.some((link) => link.tenant_company_id !== company.id)) {
      throw permissionDeniedError();
    }
    if (links.rows.some((link) => link.id !== existing?.id)) {
      throw tenantPicUserAlreadyLinkedError();
    }
    if (!(await contextAccessService.canAccessClient(nextUserId, company.clientId, tx))) {
      throw tenantPicUserClientMismatchError();
    }
  }

  // A PIC binding is shared by every request designating that PIC. Require
  // exact access to ALL such Buildings, not just a sibling in the same Client.
  // Historical requests are included, but their decisions are never rewritten.
  const requests = await tx.query<{
    client_id: string; tenant_company_id: string; building_id: string;
    valid_relationship: boolean;
  }>(
    `SELECT r.client_id, r.tenant_company_id, r.building_id,
            (r.status IN ('CANCELLED', 'REFERRED') OR EXISTS (
              SELECT 1 FROM handyman_execution_scopes es
               WHERE es.handyman_request_id = r.id AND es.client_id = r.client_id
                 AND es.tenant_company_id = r.tenant_company_id AND es.status = 'CLOSED'
            ) OR r.space_id IS NULL OR EXISTS (
              SELECT 1 FROM tenant_space_relationships tsr
               WHERE tsr.tenant_company_id = r.tenant_company_id
                 AND tsr.building_id = r.building_id AND tsr.space_id = r.space_id
                 AND tsr.status = 'ACTIVE'
                 AND (tsr.effective_from IS NULL OR tsr.effective_from <= NOW())
                 AND (tsr.effective_until IS NULL OR tsr.effective_until > NOW())
            )) AS valid_relationship
       FROM handyman_service_requests r WHERE r.tenant_pic_id = $1`,
    [existing?.id ?? null],
  );
  if (requests.rows.some((r) => r.client_id !== company.clientId || r.tenant_company_id !== company.id)) {
    throw permissionDeniedError();
  }
  // Revocation may remove a stale binding. Non-terminal requests need their
  // exact current occupancy; terminal history does not require a renewed lease
  // merely to maintain a contact. All referenced Buildings remain scoped, and
  // approval independently rechecks occupancy even for historical replays.
  if (nextUserId !== null && requests.rows.some((r) => !r.valid_relationship)) {
    throw permissionDeniedError();
  }
  const buildingIds = [...new Set(requests.rows.map((r) => r.building_id))].sort();
  const actorBuildings = await contextAccessService.getAccessibleBuildingIds(actorUserId, tx);
  const targetBuildings = nextUserId === null
    ? actorBuildings
    : await contextAccessService.getAccessibleBuildingIds(nextUserId, tx);
  for (const id of buildingIds) {
    if (!actorBuildings.includes(id)) throw buildingAccessDeniedError();
    if (!targetBuildings.includes(id)) throw tenantPicUserClientMismatchError();
  }

  // For a contact not yet designated by a request, use existing, currently
  // effective tenant locations when available. A new Client-scoped contact may
  // still be provisioned before occupancy; no request/Building rights are minted.
  if (buildingIds.length === 0) {
    const locations = await tx.query<{ building_id: string }>(
      `SELECT building_id FROM tenant_building_contexts
        WHERE tenant_company_id = $1 AND status = 'ACTIVE'
          AND (effective_from IS NULL OR effective_from <= NOW())
          AND (effective_until IS NULL OR effective_until > NOW())
       UNION
       SELECT building_id FROM tenant_space_relationships
        WHERE tenant_company_id = $1 AND status = 'ACTIVE'
          AND (effective_from IS NULL OR effective_from <= NOW())
          AND (effective_until IS NULL OR effective_until > NOW())`,
      [company.id],
    );
    if (locations.rows.length > 0) {
      if (!locations.rows.some((r) => actorBuildings.includes(r.building_id))) {
        throw buildingAccessDeniedError();
      }
      const shared = locations.rows.filter((r) =>
        actorBuildings.includes(r.building_id) && targetBuildings.includes(r.building_id));
      if (shared.length === 0) throw tenantPicUserClientMismatchError();
      buildingIds.push(...shared.map((r) => r.building_id).sort());
    }
  }

  return { authority: selfUnlink ? 'SELF_UNLINK' : 'IDENTITY_ADMIN', buildingIds };
}
