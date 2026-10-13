import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { parseHandoffCareActorClaim } from '../handyman-care-actors/handyman-care-actor.resolver';
import type { HandoffCareActorClaim } from '../handyman-care-actors/handyman-care-actor.types';
import { readHandoffIntegrationSecret } from '../handyman-handoff/handoff-runtime.config';

export const WORKSPACE_PURPOSE = 'HANDYMAN_CARE_WORKSPACE';
export const WORKSPACE_TTL_SECONDS = 900;
export type CareWorkspaceAssertion = {
  purpose: typeof WORKSPACE_PURPOSE;
  integrationCode: string;
  assertionId: string;
  issuedAt: string;
  expiresAt: string;
  actor: HandoffCareActorClaim;
};
/** Deliberately has no userId/PIC, represented tenant, or property grants. */
export type CareWorkspacePrincipal = Readonly<{
  actorType: 'CUSTOMER_CARE';
  sessionId: string;
  careActorId: string;
  integrationId: string;
  expiresAt: string;
}>;

export function workspaceUnauthorized(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED,
    message: 'Care workspace authentication failed.', statusCode: 401,
  });
}

export function signCareWorkspaceAssertion(assertion: CareWorkspaceAssertion, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(stableJson(assertion)).digest('hex');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseAssertion(value: unknown): CareWorkspaceAssertion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw workspaceUnauthorized();
  const record = value as Record<string, unknown>;
  const keys = ['purpose', 'integrationCode', 'assertionId', 'issuedAt', 'expiresAt', 'actor'];
  if (Object.keys(record).length !== keys.length ||
      Object.keys(record).some(key => !keys.includes(key)) ||
      record.purpose !== WORKSPACE_PURPOSE) throw workspaceUnauthorized();
  for (const key of ['integrationCode', 'assertionId']) {
    const v = record[key];
    if (typeof v !== 'string' || !v.length || v.length > 128 || v.trim() !== v) {
      throw workspaceUnauthorized();
    }
  }
  const actor = parseHandoffCareActorClaim(record.actor);
  if (!actor) throw workspaceUnauthorized();
  // Sign exact input values, never a silently trimmed/normalized payload.
  for (const key of ['issuedAt', 'expiresAt']) {
    if (typeof record[key] !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(record[key] as string) ||
        !Number.isFinite(Date.parse(record[key] as string)) ||
        new Date(record[key] as string).toISOString().slice(0, 19) !== (record[key] as string).slice(0, 19)) {
      throw workspaceUnauthorized();
    }
  }
  return value as CareWorkspaceAssertion;
}

function assertWindow(assertion: CareWorkspaceAssertion, now: number): void {
  const issued = Date.parse(assertion.issuedAt);
  const expires = Date.parse(assertion.expiresAt);
  if (issued > now || expires <= now || expires <= issued || expires - issued > 300_000) {
    throw workspaceUnauthorized();
  }
}

/** Lock current authority before issuing or using a credential. Transitions
 * invalidate sessions with database triggers, including deactivate/reactivate
 * cycles between uses. No caching and no local User resolver. */
async function resolveActor(tx: PoolClient, integrationCode: string, actorReference: string) {
  const result = await tx.query<{ careActorId: string; integrationId: string }>(
    `SELECT a.id AS "careActorId", i.id AS "integrationId"
       FROM handyman_handoff_integrations i
       JOIN handyman_handoff_care_actors a ON a.integration_id = i.id
       WHERE i.integration_code = $1 AND a.actor_reference = $2
         AND i.status = 'ACTIVE' AND i.actor_capability = 'CUSTOMER_CARE'
         AND a.status = 'ACTIVE' FOR SHARE OF i, a`,
    [integrationCode, actorReference.trim()],
  );
  if (!result.rows[0]) throw workspaceUnauthorized();
  return result.rows[0];
}

export async function admitCareWorkspace(body: unknown, signature: string | undefined) {
  const assertion = parseAssertion(body);
  assertWindow(assertion, Date.now());
  const secret = readHandoffIntegrationSecret(assertion.integrationCode);
  if (!secret || !signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) throw workspaceUnauthorized();
  const expected = signCareWorkspaceAssertion(assertion, secret);
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw workspaceUnauthorized();
  try {
    return await withTransaction(async tx => {
      const actor = await resolveActor(tx, assertion.integrationCode, assertion.actor.actorReference);
      const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const now = clock.rows[0].now;
      assertWindow(assertion, now.getTime());
      // Prefix assists kind separation; independent hash store is the authority.
      const workspaceToken = 'hcw_' + randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + WORKSPACE_TTL_SECONDS * 1000);
      await tx.query(
        `INSERT INTO handyman_care_workspace_sessions
         (id, integration_id, care_actor_id, assertion_id, token_hash, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), actor.integrationId, actor.careActorId, assertion.assertionId,
          hashToken(workspaceToken), now, expiresAt],
      );
      return { workspaceToken, expiresAt: expiresAt.toISOString() };
    });
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'handyman_care_workspace_assertion_unique') {
      throw workspaceUnauthorized();
    }
    // Infrastructure errors are never turned into successful/stale authority.
    throw error;
  }
}

async function useSession(token: string, revoke: boolean): Promise<CareWorkspacePrincipal> {
  if (typeof token !== 'string' || !/^hcw_[A-Za-z0-9_-]{43}$/.test(token)) throw workspaceUnauthorized();
  return withTransaction(async tx => {
    // Lock authority first (not the session), matching invalidation triggers'
    // authority -> session order. The later session lock sees committed revoke.
    const authority = await tx.query(
      `SELECT a.id FROM handyman_care_workspace_sessions s
       JOIN handyman_handoff_integrations i ON i.id = s.integration_id
       JOIN handyman_handoff_care_actors a ON a.id = s.care_actor_id AND a.integration_id = i.id
       WHERE s.token_hash = $1 AND a.status = 'ACTIVE'
         AND i.status = 'ACTIVE' AND i.actor_capability = 'CUSTOMER_CARE'
       FOR SHARE OF i, a`, [hashToken(token)],
    );
    if (authority.rowCount !== 1) throw workspaceUnauthorized();
    const result = await tx.query<{
      id: string; careActorId: string; integrationId: string; expiresAt: Date; revokedAt: Date | null;
    }>(
      `SELECT id, care_actor_id AS "careActorId", integration_id AS "integrationId",
        expires_at AS "expiresAt", revoked_at AS "revokedAt"
       FROM handyman_care_workspace_sessions
       WHERE token_hash = $1 AND expires_at > clock_timestamp() FOR UPDATE`, [hashToken(token)],
    );
    const session = result.rows[0];
    if (!session || (!revoke && session.revokedAt)) throw workspaceUnauthorized();
    // A row-lock wait must not authorize a token that expired while waiting.
    const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    if (session.expiresAt.getTime() <= clock.rows[0].now.getTime()) throw workspaceUnauthorized();
    if (revoke && !session.revokedAt) {
      await tx.query('UPDATE handyman_care_workspace_sessions SET revoked_at = clock_timestamp() WHERE id = $1', [session.id]);
    }
    return Object.freeze({ actorType: 'CUSTOMER_CARE' as const, sessionId: session.id,
      careActorId: session.careActorId, integrationId: session.integrationId,
      expiresAt: session.expiresAt.toISOString() });
  });
}

/** Authentication only. Future callers must separately authorize resources. */
export function resolveCareWorkspacePrincipal(token: string): Promise<CareWorkspacePrincipal> {
  return useSession(token, false);
}

/** Logout is idempotent for an unexpired revoked token with active identity. */
export async function revokeCareWorkspaceSession(token: string): Promise<void> {
  await useSession(token, true);
}
