import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import { userRepository } from '../users';

/**
 * CR-HM-CUSTOMER-PAYMENT-REPORT-01 PART 05/06 — permission provisioning for
 * Customer Care actors (non-User principals).
 *
 * Mechanism: a grant references the EXISTING permission catalogue by code
 * (`permissions.code`). Authority is the permission code, never a role name.
 *
 * PART 06 administrative rules (all fail-closed):
 *  1. RBAC at the route: `permission.read` (list) / `permission.manage` (grant, revoke).
 *  2. Grantor is an ACTIVE User who holds `permission.manage` and the permission
 *     being delegated (delegation ceiling).
 *  3. Scope: the grantor must have explicit building access to a property where
 *     the care actor holds a property grant. Grant requires an ACTIVE property
 *     grant; revoke/list also accept revoked property history so that access
 *     can be withdrawn after the property grant itself was revoked.
 *  4. Audit: every effective grant/revoke writes an operational event inside the
 *     same transaction. Idempotent replays write nothing.
 *
 * The allowlist is the only care-actor-grantable set; verify is never grantable here.
 */
export const CARE_ACTOR_PAYMENT_REPORT_PERMISSION = 'handyman.payment.report';
export const CARE_ACTOR_GRANTABLE_PERMISSION_CODES: readonly string[] = [
  CARE_ACTOR_PAYMENT_REPORT_PERMISSION,
];

type Executor = Pick<PoolClient, 'query'>;

export type CareActorPermissionGrant = {
  id: string;
  careActorId: string;
  permissionCode: string;
  status: 'ACTIVE' | 'REVOKED';
  grantedByUserId: string;
  grantedAt: string;
  revokedByUserId: string | null;
  revokedAt: string | null;
};

const SELECT = `
  SELECT id, care_actor_id, permission_code, status, granted_by_user_id,
         granted_at, revoked_by_user_id, revoked_at
    FROM handyman_care_actor_permission_grants`;

function mapGrant(row: Record<string, any>): CareActorPermissionGrant {
  return {
    id: row.id,
    careActorId: row.care_actor_id,
    permissionCode: row.permission_code,
    status: row.status,
    grantedByUserId: row.granted_by_user_id,
    grantedAt: row.granted_at.toISOString(),
    revokedByUserId: row.revoked_by_user_id ?? null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw AppError.validation(`${field} must be a valid UUID.`);
  }
  return value.toLowerCase();
}

export function assertCareActorGrantablePermissionCode(code: unknown): string {
  if (typeof code !== 'string' || !CARE_ACTOR_GRANTABLE_PERMISSION_CODES.includes(code)) {
    throw AppError.validation('permissionCode is not grantable to a care actor.');
  }
  return code;
}

function permissionDenied(message: string): AppError {
  return new AppError({ code: ERROR_CODES.PERMISSION_DENIED, message, statusCode: 403 });
}

/** Grantor must be an ACTIVE User holding `permission.manage` and the delegated code. */
async function assertGrantorDelegation(grantorUserId: string, code: string): Promise<void> {
  const user = await userRepository.findById(grantorUserId);
  if (user?.status !== 'ACTIVE') throw permissionDenied('Grantor is not an active user.');
  const held = await permissionService.resolvePermissionsForUser(grantorUserId);
  if (!held.includes('permission.manage')) {
    throw permissionDenied('Grantor does not hold permission.manage.');
  }
  if (!held.includes(code)) {
    throw permissionDenied('Grantor does not hold the permission being delegated.');
  }
}

/**
 * Scope: returns the first property (with its client) under which the care actor
 * has a property grant that the grantor can access. Fail-closed otherwise.
 */
async function resolveAdministrativeScope(
  executor: Executor,
  grantorUserId: string,
  careActorId: string,
  includeRevoked: boolean,
): Promise<{ propertyId: string; clientId: string }> {
  const result = await executor.query<{ property_id: string; client_id: string }>(
    `SELECT DISTINCT g.property_id, p.client_id
       FROM handyman_care_property_grants g
       JOIN properties p ON p.id = g.property_id
      WHERE g.care_actor_id = $1 AND ($2::boolean OR g.status = 'ACTIVE')
      ORDER BY g.property_id`,
    [careActorId, includeRevoked],
  );
  for (const row of result.rows) {
    if (await contextAccessService.canAccessProperty(grantorUserId, row.property_id)) {
      return { propertyId: row.property_id, clientId: row.client_id };
    }
  }
  throw buildingAccessDeniedError();
}

async function assertActiveCareActor(executor: Executor, careActorId: string): Promise<void> {
  const actor = await executor.query(
    `SELECT status FROM handyman_handoff_care_actors WHERE id = $1 FOR SHARE`,
    [careActorId],
  );
  if (actor.rows[0]?.status !== 'ACTIVE') {
    throw AppError.validation('careActorId must reference an ACTIVE care actor.');
  }
}

async function assertCatalogueActive(executor: Executor, code: string): Promise<void> {
  const catalogue = await executor.query(
    `SELECT 1 FROM permissions WHERE code = $1 AND status = 'ACTIVE'`,
    [code],
  );
  if (catalogue.rowCount !== 1) {
    throw AppError.validation('permissionCode is not an ACTIVE catalogue permission.');
  }
}

/**
 * Grant (ACTIVE). Returns `created: false` for an idempotent replay, which
 * writes no new grant and no new audit event.
 */
export async function grantCareActorPermission(
  input: { careActorId: string; permissionCode: string },
  grantorUserId: string,
): Promise<{ grant: CareActorPermissionGrant; created: boolean }> {
  const careActorId = uuid(input.careActorId, 'careActorId');
  const code = assertCareActorGrantablePermissionCode(input.permissionCode);
  const grantor = uuid(grantorUserId, 'grantorUserId');
  await assertGrantorDelegation(grantor, code);
  return withTransaction(async (tx) => {
    await assertActiveCareActor(tx, careActorId);
    await assertCatalogueActive(tx, code);
    const scope = await resolveAdministrativeScope(tx, grantor, careActorId, false);
    const inserted = await tx.query(
      `INSERT INTO handyman_care_actor_permission_grants
         (id, care_actor_id, permission_code, status, granted_by_user_id)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', $3)
       ON CONFLICT (care_actor_id, permission_code) WHERE status = 'ACTIVE' DO NOTHING
       RETURNING id`,
      [careActorId, code, grantor],
    );
    if (!inserted.rows[0]) {
      const existing = await tx.query(
        `${SELECT} WHERE care_actor_id = $1 AND permission_code = $2 AND status = 'ACTIVE'`,
        [careActorId, code],
      );
      return { grant: mapGrant(existing.rows[0]), created: false };
    }
    const row = await tx.query(`${SELECT} WHERE id = $1`, [inserted.rows[0].id]);
    await recordOperationalEvent({
      clientId: scope.clientId,
      actorUserId: grantor,
      eventType: 'HANDYMAN_CARE_ACTOR_PERMISSION_GRANTED',
      entityType: 'HANDYMAN_CARE_ACTOR_PERMISSION_GRANT',
      entityId: inserted.rows[0].id,
      summary: 'Customer Care actor permission granted.',
      metadata: { careActorId, permissionCode: code, propertyId: scope.propertyId },
    }, tx);
    return { grant: mapGrant(row.rows[0]), created: true };
  });
}

/**
 * ACTIVE -> REVOKED. Throws 404 when no ACTIVE grant exists (no silent no-op,
 * no audit for a non-effective request).
 */
export async function revokeCareActorPermission(
  input: { careActorId: string; permissionCode: string },
  revokerUserId: string,
): Promise<CareActorPermissionGrant> {
  const careActorId = uuid(input.careActorId, 'careActorId');
  const code = assertCareActorGrantablePermissionCode(input.permissionCode);
  const revoker = uuid(revokerUserId, 'revokerUserId');
  await assertGrantorDelegation(revoker, code);
  return withTransaction(async (tx) => {
    const scope = await resolveAdministrativeScope(tx, revoker, careActorId, true);
    const updated = await tx.query(
      `UPDATE handyman_care_actor_permission_grants
          SET status = 'REVOKED', revoked_by_user_id = $3, revoked_at = NOW()
        WHERE care_actor_id = $1 AND permission_code = $2 AND status = 'ACTIVE'
        RETURNING id`,
      [careActorId, code, revoker],
    );
    if (!updated.rows[0]) {
      throw AppError.notFound('Active care actor permission grant not found.');
    }
    const row = await tx.query(`${SELECT} WHERE id = $1`, [updated.rows[0].id]);
    await recordOperationalEvent({
      clientId: scope.clientId,
      actorUserId: revoker,
      eventType: 'HANDYMAN_CARE_ACTOR_PERMISSION_REVOKED',
      entityType: 'HANDYMAN_CARE_ACTOR_PERMISSION_GRANT',
      entityId: updated.rows[0].id,
      summary: 'Customer Care actor permission revoked.',
      metadata: { careActorId, permissionCode: code, propertyId: scope.propertyId },
    }, tx);
    return mapGrant(row.rows[0]);
  });
}

/** Administrative read of grants (ACTIVE and REVOKED history) under the same scope rule. */
export async function listCareActorPermissionGrants(
  input: { careActorId: string },
  readerUserId: string,
): Promise<CareActorPermissionGrant[]> {
  const careActorId = uuid(input.careActorId, 'careActorId');
  const reader = uuid(readerUserId, 'readerUserId');
  const user = await userRepository.findById(reader);
  const held = user?.status === 'ACTIVE'
    ? await permissionService.resolvePermissionsForUser(reader)
    : [];
  if (!held.includes('permission.read')) {
    throw permissionDenied('Reader does not hold permission.read.');
  }
  await resolveAdministrativeScope(getPool(), reader, careActorId, true);
  const result = await getPool().query(
    `${SELECT} WHERE care_actor_id = $1 ORDER BY granted_at, id`,
    [careActorId],
  );
  return result.rows.map(mapGrant);
}

/**
 * Authority read for a care actor. Inside a transaction it takes a shared
 * lock on the grant and the catalogue row so revocation cannot race past it.
 */
export async function hasActiveCareActorPermission(
  careActorId: string,
  permissionCode: string,
  tx?: Executor,
): Promise<boolean> {
  const result = await (tx ?? getPool()).query(
    `SELECT 1
       FROM handyman_care_actor_permission_grants g
       JOIN permissions p ON p.code = g.permission_code
      WHERE g.care_actor_id = $1 AND g.permission_code = $2
        AND g.status = 'ACTIVE' AND p.status = 'ACTIVE'
        ${tx ? 'FOR SHARE OF g, p' : ''}`,
    [careActorId, permissionCode],
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * In-transaction re-check of a workspace session: not revoked, not expired
 * (DB clock), and its care actor and integration still ACTIVE with the
 * CUSTOMER_CARE capability. Locks match `useSession` (authority first).
 */
export async function isCareWorkspaceSessionActive(
  tx: Executor,
  input: { sessionId: string; careActorId: string },
): Promise<boolean> {
  const result = await tx.query(
    `SELECT 1
       FROM handyman_care_workspace_sessions s
       JOIN handyman_handoff_integrations i ON i.id = s.integration_id
       JOIN handyman_handoff_care_actors a
         ON a.id = s.care_actor_id AND a.integration_id = i.id
      WHERE s.id = $1 AND s.care_actor_id = $2
        AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
        AND a.status = 'ACTIVE' AND i.status = 'ACTIVE'
        AND i.actor_capability = 'CUSTOMER_CARE'
      FOR SHARE OF i, a, s`,
    [input.sessionId, input.careActorId],
  );
  return (result.rowCount ?? 0) === 1;
}
