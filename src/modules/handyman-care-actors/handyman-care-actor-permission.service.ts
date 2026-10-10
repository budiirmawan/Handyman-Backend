import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { permissionService } from '../permissions';

/**
 * CR-HM-CUSTOMER-PAYMENT-REPORT-01 PART 05 — permission provisioning for
 * Customer Care actors (non-User principals).
 *
 * Mechanism: a grant references the EXISTING permission catalogue by code
 * (`permissions.code`). Authority is the permission code, never a role name.
 * Delegation ceiling: a grantor may only grant/revoke a permission they hold
 * through the existing RBAC resolution (`permissionService`). The allowlist
 * below is the only care-actor-grantable set; verify is never grantable here.
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

function allowlisted(code: unknown): string {
  if (typeof code !== 'string' || !CARE_ACTOR_GRANTABLE_PERMISSION_CODES.includes(code)) {
    throw AppError.validation('permissionCode is not grantable to a care actor.');
  }
  return code;
}

/** Delegation ceiling: the grantor must hold the permission itself. */
async function assertGrantorHoldsPermission(grantorUserId: string, code: string) {
  const held = await permissionService.resolvePermissionsForUser(grantorUserId);
  if (!held.includes(code)) {
    throw new AppError({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: 'Grantor does not hold the permission being delegated.',
      statusCode: 403,
    });
  }
}

export async function grantCareActorPermission(
  input: { careActorId: string; permissionCode: string },
  grantorUserId: string,
): Promise<CareActorPermissionGrant> {
  const careActorId = uuid(input.careActorId, 'careActorId');
  const code = allowlisted(input.permissionCode);
  const grantor = uuid(grantorUserId, 'grantorUserId');
  await assertGrantorHoldsPermission(grantor, code);
  const client = getPool();
  const actor = await client.query(
    `SELECT status FROM handyman_handoff_care_actors WHERE id = $1`,
    [careActorId],
  );
  if (actor.rows[0]?.status !== 'ACTIVE') {
    throw AppError.validation('careActorId must reference an ACTIVE care actor.');
  }
  const catalogue = await client.query(
    `SELECT 1 FROM permissions WHERE code = $1 AND status = 'ACTIVE'`,
    [code],
  );
  if (catalogue.rowCount !== 1) {
    throw AppError.validation('permissionCode is not an ACTIVE catalogue permission.');
  }
  // Idempotent: an existing ACTIVE grant is returned unchanged.
  const inserted = await client.query(
    `INSERT INTO handyman_care_actor_permission_grants
       (id, care_actor_id, permission_code, status, granted_by_user_id)
     VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', $3)
     ON CONFLICT (care_actor_id, permission_code) WHERE status = 'ACTIVE' DO NOTHING
     RETURNING id`,
    [careActorId, code, grantor],
  );
  const result = inserted.rows[0]
    ? await client.query(`${SELECT} WHERE id = $1`, [inserted.rows[0].id])
    : await client.query(
        `${SELECT} WHERE care_actor_id = $1 AND permission_code = $2 AND status = 'ACTIVE'`,
        [careActorId, code],
      );
  return mapGrant(result.rows[0]);
}

/** ACTIVE -> REVOKED. Idempotent: returns null when no ACTIVE grant exists. */
export async function revokeCareActorPermission(
  input: { careActorId: string; permissionCode: string },
  revokerUserId: string,
): Promise<CareActorPermissionGrant | null> {
  const careActorId = uuid(input.careActorId, 'careActorId');
  const code = allowlisted(input.permissionCode);
  const revoker = uuid(revokerUserId, 'revokerUserId');
  await assertGrantorHoldsPermission(revoker, code);
  const result = await getPool().query(
    `UPDATE handyman_care_actor_permission_grants
        SET status = 'REVOKED', revoked_by_user_id = $3, revoked_at = NOW()
      WHERE care_actor_id = $1 AND permission_code = $2 AND status = 'ACTIVE'
      RETURNING id`,
    [careActorId, code, revoker],
  );
  if (!result.rows[0]) return null;
  const row = await getPool().query(`${SELECT} WHERE id = $1`, [result.rows[0].id]);
  return mapGrant(row.rows[0]);
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
