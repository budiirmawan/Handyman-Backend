import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { recordOperationalEvent } from '../operational-events';
import { readHandoffIntegrationSecret } from '../handyman-handoff/handoff-runtime.config';
import { resolveHandoffContext } from '../handyman-handoff/handoff-context.service';
import type { ResolvedHandoffContext } from '../handyman-handoff/handoff-context.types';
import {
  picWorkspaceRejectsContextError,
  picWorkspaceUnauthorized,
} from './pic-workspace-session.errors';
import { handymanPicWorkspaceSessionRepository as repo } from './pic-workspace-session.repository';
import {
  PIC_WORKSPACE_ASSERTION_KEYS,
  PIC_WORKSPACE_ASSERTION_MAX_WINDOW_MS,
  PIC_WORKSPACE_PURPOSE,
  PIC_WORKSPACE_REPRESENTATION_KEYS,
  PIC_WORKSPACE_REPRESENTATION_REQUIRED_KEYS,
  PIC_WORKSPACE_TOKEN_PREFIX,
  PIC_WORKSPACE_TOKEN_PATTERN,
  readPicWorkspaceRuntimeConfig,
  toPublicPicWorkspaceSession,
  type PicWorkspaceAssertion,
  type PicWorkspaceAdmissionResult,
  type PicWorkspacePrincipal,
  type PicWorkspaceRepresentation,
  type PublicPicWorkspaceSession,
} from './pic-workspace-session.types';

/**
 * W03 PART 03C — admission, use, and revocation of the bounded Tenant PIC
 * session (A01 §5, rules 1–19).
 *
 * THE ONE THING THAT CROSSES THE TRUST BOUNDARY is an HMAC signature over a
 * canonical assertion, made with the per-integration secret that only BM and
 * this server hold (§4). Everything else — tenant, PIC, building, space,
 * occupancy validity, whether this admission may decide at all — is DERIVED by
 * `resolveHandoffContext`, which is reused unchanged and is the only occupancy
 * master (rule 11). A caller-supplied UUID that the resolver does not confirm
 * for exactly this integration's assertion never reaches the database.
 *
 * The machinery is the care workspace's, the semantics are not (A2/§12 D4):
 * no local user, no role, no RBAC grant, no property picker, no per-call
 * context selection. PIC and care assertions are isolated by PURPOSE first, so
 * a care-actor block can never validate as PIC admission, and vice versa.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECOND_PRECISION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Canonical signature payload. `stableJson` keeps key order irrelevant, so BM
 * and Handyman agree over the bytes without either side re-serialising. */
export function canonicalPicWorkspaceAssertion(
  assertion: PicWorkspaceAssertion,
): string {
  return stableJson(assertion);
}

/** BM-side (and test-side) signer: 'sha256=<hmac-hex>' over the canonical form. */
export function signPicWorkspaceAssertion(
  assertion: PicWorkspaceAssertion,
  integrationSecret: string,
): string {
  return (
    'sha256=' +
    createHmac('sha256', integrationSecret)
      .update(canonicalPicWorkspaceAssertion(assertion))
      .digest('hex')
  );
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): boolean {
  const keys = Object.keys(record);
  return (
    keys.every(key => allowed.includes(key)) &&
    required.every(key => keys.includes(key))
  );
}

function parseRepresentation(value: unknown): PicWorkspaceRepresentation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw picWorkspaceUnauthorized();
  }
  const record = value as Record<string, unknown>;
  // Rule 3 — exactly these names, required/optional as the handoff context
  // defines them. No new claim vocabulary, so no vocabulary to keep in sync.
  if (!exactKeys(record, PIC_WORKSPACE_REPRESENTATION_KEYS,
                 PIC_WORKSPACE_REPRESENTATION_REQUIRED_KEYS)) {
    throw picWorkspaceUnauthorized();
  }
  const parsed: Record<string, string> = {};
  for (const key of PIC_WORKSPACE_REPRESENTATION_KEYS) {
    const field = record[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || !UUID_PATTERN.test(field)) {
      throw picWorkspaceUnauthorized();
    }
    parsed[key] = field;
  }
  return {
    tenantCompanyId: parsed.tenantCompanyId,
    buildingId: parsed.buildingId,
    ...(parsed.tenantPicId ? { tenantPicId: parsed.tenantPicId } : {}),
    ...(parsed.spaceId ? { spaceId: parsed.spaceId } : {}),
  };
}

/** Rule 2 + rule 3 + rule 4 structural half. Every failure is the SAME 401. */
export function parsePicWorkspaceAssertion(
  value: unknown,
): PicWorkspaceAssertion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw picWorkspaceUnauthorized();
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, PIC_WORKSPACE_ASSERTION_KEYS) ||
      record.purpose !== PIC_WORKSPACE_PURPOSE) {
    throw picWorkspaceUnauthorized();
  }
  for (const key of ['integrationCode', 'assertionId']) {
    const field = record[key];
    if (typeof field !== 'string' || field.length === 0 ||
        field.length > 128 || field.trim() !== field) {
      throw picWorkspaceUnauthorized();
    }
  }
  // Sign the exact input values, never a silently trimmed/normalized payload
  // (the care-workspace rule this mirrors: normalising before verification
  // would make the signature cover something BM never sent).
  for (const key of ['issuedAt', 'expiresAt']) {
    const field = record[key];
    if (typeof field !== 'string' || !SECOND_PRECISION.test(field) ||
        !Number.isFinite(Date.parse(field)) ||
        new Date(field).toISOString().slice(0, 19) !== field.slice(0, 19)) {
      throw picWorkspaceUnauthorized();
    }
  }
  const representation = parseRepresentation(record.representation);
  return {
    purpose: PIC_WORKSPACE_PURPOSE,
    integrationCode: record.integrationCode as string,
    assertionId: record.assertionId as string,
    issuedAt: record.issuedAt as string,
    expiresAt: record.expiresAt as string,
    representation,
  };
}

/** Rule 4 — issued strictly in the past, not yet expired, monotone, and the
 * whole assertion window is at most 300s. */
function assertAssertionWindow(assertion: PicWorkspaceAssertion, now: number): void {
  const issued = Date.parse(assertion.issuedAt);
  const expires = Date.parse(assertion.expiresAt);
  if (issued >= now || expires <= now || expires <= issued ||
      expires - issued > PIC_WORKSPACE_ASSERTION_MAX_WINDOW_MS) {
    throw picWorkspaceUnauthorized();
  }
}

/** Signature verification (T2). Fixed-shape header first so the constant-time
 * comparison never runs on mismatched buffer lengths. */
function verifySignature(assertion: PicWorkspaceAssertion, signature: string | undefined): void {
  const secret = readHandoffIntegrationSecret(assertion.integrationCode);
  if (!secret || typeof signature !== 'string' ||
      !/^sha256=[0-9a-f]{64}$/.test(signature)) {
    throw picWorkspaceUnauthorized();
  }
  const expected = Buffer.from(signPicWorkspaceAssertion(assertion, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length ||
      !timingSafeEqual(expected, received)) {
    throw picWorkspaceUnauthorized();
  }
}

/**
 * Rule 11: the identities STORED are the resolver's output, not the caller's
 * input. A resolver rejection (AppError) collapses into the uniform 401;
 * anything else propagates (T9) — a pool or driver failure is never reported
 * as "not authorized" and never retried into a stale grant.
 */
async function resolveRepresentation(
  representation: PicWorkspaceRepresentation,
): Promise<ResolvedHandoffContext> {
  try {
    return await resolveHandoffContext(representation);
  } catch (error) {
    if (error instanceof AppError) throw picWorkspaceUnauthorized();
    throw error;
  }
}

function principalOf(
  row: {
    sessionId: string;
    integrationId: string;
    tenantCompanyId: string;
    tenantPicId: string | null;
    buildingId: string;
    spaceId: string | null;
    tenantBuildingContextId: string;
    createdAt: Date;
    expiresAt: Date;
  },
): PicWorkspacePrincipal {
  return Object.freeze({
    actorType: 'TENANT_PIC' as const,
    sessionId: row.sessionId,
    integrationId: row.integrationId,
    tenantCompanyId: row.tenantCompanyId,
    tenantPicId: row.tenantPicId,
    buildingId: row.buildingId,
    spaceId: row.spaceId,
    tenantBuildingContextId: row.tenantBuildingContextId,
    canDecide: row.tenantPicId !== null,
    issuedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  });
}

/** Journal row for an admission or a revocation: ids and the window only. No
 * name, e-mail, phone, token, or hash — and `SENSITIVE_KEYS` in
 * `operational-events` is the floor, not the design. */
async function journalSession(
  tx: PoolClient,
  kind: 'ADMITTED' | 'REVOKED',
  input: {
    sessionId: string;
    clientId: string;
    integrationId: string;
    tenantCompanyId: string;
    tenantPicId: string | null;
    buildingId: string;
    spaceId: string | null;
    canDecide: boolean;
    expiresAt: Date;
  },
): Promise<void> {
  await recordOperationalEvent(
    {
      clientId: input.clientId,
      eventType: `HANDYMAN_PIC_WORKSPACE_SESSION_${kind}`,
      entityType: 'HANDYMAN_PIC_WORKSPACE_SESSION',
      entityId: input.sessionId,
      // A PIC has no local user (A2): the actor of its own admission is the
      // session, and `actor_user_id` stays NULL rather than being filled in.
      actorUserId: null,
      buildingId: input.buildingId,
      summary:
        kind === 'ADMITTED'
          ? 'Handyman PIC workspace session admitted.'
          : 'Handyman PIC workspace session revoked.',
      metadata: {
        sessionId: input.sessionId,
        integrationId: input.integrationId,
        tenantCompanyId: input.tenantCompanyId,
        tenantPicId: input.tenantPicId,
        buildingId: input.buildingId,
        spaceId: input.spaceId,
        canDecide: input.canDecide,
        expiresAt: input.expiresAt.toISOString(),
        ...(kind === 'REVOKED' ? { revokedAt: new Date().toISOString() } : {}),
      },
    },
    tx,
  );
}

/**
 * Rules 1–9. No local-user middleware and no permission code participates:
 * admission is authenticated by the signature, and the identity is whatever
 * `resolveHandoffContext` confirms about the representation BM named.
 */
export async function admitPicWorkspace(
  body: unknown,
  signature: string | undefined,
): Promise<PicWorkspaceAdmissionResult> {
  const assertion = parsePicWorkspaceAssertion(body);
  assertAssertionWindow(assertion, Date.now());
  verifySignature(assertion, signature);
  try {
    return await withTransaction(async tx => {
      // Rule 9: structural validity -> HMAC + window -> resolve -> INSERT
      // tombstone -> token, with authority locked before the session row.
      const integration = await repo.lockAttestingIntegration(
        tx,
        assertion.integrationCode,
      );
      if (!integration) throw picWorkspaceUnauthorized();
      const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const now = clock.rows[0].now;
      assertAssertionWindow(assertion, now.getTime());
      const resolved = await resolveRepresentation(assertion.representation);

      const sessionId = randomUUID();
      const workspaceToken =
        PIC_WORKSPACE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
      const { ttlSeconds } = readPicWorkspaceRuntimeConfig();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      await repo.insertPicWorkspaceSession(tx, {
        id: sessionId,
        integrationId: integration.integrationId,
        tenantCompanyId: resolved.tenantCompanyId,
        tenantPicId: resolved.tenantPicId,
        buildingId: resolved.buildingId,
        spaceId: resolved.spaceId,
        tenantBuildingContextId: resolved.tenantBuildingContextId,
        assertionId: assertion.assertionId,
        tokenHash: hashToken(workspaceToken),
        createdAt: now,
        expiresAt,
      });
      await journalSession(tx, 'ADMITTED', {
        sessionId,
        clientId: resolved.clientId,
        integrationId: integration.integrationId,
        tenantCompanyId: resolved.tenantCompanyId,
        tenantPicId: resolved.tenantPicId,
        buildingId: resolved.buildingId,
        spaceId: resolved.spaceId,
        canDecide: resolved.tenantPicId !== null,
        expiresAt,
      });
      // Rule 1: the token is returned exactly once, and never inside any
      // other projection of this surface.
      return { workspaceToken, expiresAt: expiresAt.toISOString() };
    });
  } catch (error) {
    // Rule 16: a replayed assertion mints nothing and says nothing more than
    // every other refusal.
    const pgError = error as { code?: string; constraint?: string };
    if (
      pgError.code === '23505' &&
      pgError.constraint === 'handyman_pic_workspace_assertion_unique'
    ) {
      throw picWorkspaceUnauthorized();
    }
    throw error;
  }
}

/**
 * Rule 17, in its stated order, on EVERY authenticated call: absolute expiry
 * against clock_timestamp(), revocation, integration ACTIVE + capability,
 * current representation validity, then the PIC/company checks. The revocation
 * triggers are defense in depth, never the mechanism the service relies on: a
 * context that simply went out of effect (no status change, so no trigger) is
 * caught here by re-resolution and the FOR SHARE locks.
 */
async function useSession(
  token: string,
  mode: 'use' | 'revoke',
): Promise<{ principal: PicWorkspacePrincipal; revoked: boolean }> {
  if (typeof token !== 'string' || !PIC_WORKSPACE_TOKEN_PATTERN.test(token)) {
    throw picWorkspaceUnauthorized();
  }
  const tokenHash = hashToken(token);
  return withTransaction(async tx => {
    const row = await repo.findPicWorkspaceSessionByTokenHash(tx, tokenHash);
    if (!row) throw picWorkspaceUnauthorized();
    const locked = await repo.lockPicWorkspaceSession(tx, row.sessionId);
    if (!locked) throw picWorkspaceUnauthorized();
    // A logout stays idempotent for an already-revoked, still-unexpired token;
    // any other use of a revoked credential is refused.
    if (locked.revokedAt !== null && mode !== 'revoke') {
      throw picWorkspaceUnauthorized();
    }
    const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    if (locked.expiresAt.getTime() <= clock.rows[0].now.getTime()) {
      throw picWorkspaceUnauthorized();
    }

    // The snapshot's NULLs are "absent by resolution", not claims, so the
    // re-entry into the resolver uses the conditional form it accepts (the same
    // shape `isCurrentCareRepresentation` builds).
    const claims = {
      tenantCompanyId: row.tenantCompanyId,
      buildingId: row.buildingId,
      ...(row.tenantPicId ? { tenantPicId: row.tenantPicId } : {}),
      ...(row.spaceId ? { spaceId: row.spaceId } : {}),
    };
    let current: ResolvedHandoffContext;
    try {
      current = await resolveHandoffContext(claims);
    } catch (error) {
      if (error instanceof AppError) throw picWorkspaceUnauthorized();
      throw error;
    }
    if (current.tenantCompanyId !== row.tenantCompanyId ||
        current.buildingId !== row.buildingId ||
        current.tenantPicId !== row.tenantPicId ||
        current.spaceId !== row.spaceId ||
        current.tenantBuildingContextId !== row.tenantBuildingContextId) {
      throw picWorkspaceUnauthorized();
    }
    if (
      !(await repo.lockCurrentRepresentation(tx, {
        tenantCompanyId: row.tenantCompanyId,
        buildingId: row.buildingId,
        spaceId: row.spaceId,
        tenantBuildingContextId: row.tenantBuildingContextId,
      }))
    ) {
      throw picWorkspaceUnauthorized();
    }

    const principal = principalOf({ ...row, createdAt: locked.createdAt, expiresAt: locked.expiresAt });
    let revoked = false;
    if (mode === 'revoke' && !locked.revokedAt) {
      revoked = await repo.revokePicWorkspaceSessionRow(tx, row.sessionId);
      if (revoked) {
        await journalSession(tx, 'REVOKED', {
          sessionId: row.sessionId,
          clientId: current.clientId,
          integrationId: row.integrationId,
          tenantCompanyId: row.tenantCompanyId,
          tenantPicId: row.tenantPicId,
          buildingId: row.buildingId,
          spaceId: row.spaceId,
          canDecide: principal.canDecide,
          expiresAt: locked.expiresAt,
        });
      }
    }
    return { principal, revoked };
  });
}

/** Authentication only; resource authorization stays with the caller (03D/03E). */
export function resolvePicWorkspacePrincipal(
  token: string,
): Promise<PicWorkspacePrincipal> {
  return useSession(token, 'use').then(result => result.principal);
}

/** Session introspection: the caller's own credential facts, projected minimally. */
export async function readPicWorkspaceSession(
  token: string,
): Promise<PublicPicWorkspaceSession> {
  const { principal } = await useSession(token, 'use');
  return toPublicPicWorkspaceSession(principal);
}

/** Rule 18 — 204 idempotent for an unexpired revoked token; nothing else. */
export async function revokePicWorkspaceSession(token: string): Promise<void> {
  await useSession(token, 'revoke');
}

/** Route-level guard shared with the routers of the other credential kinds. */
export function readPicWorkspaceBearer(
  authorization: string | undefined,
  query: unknown,
  body: unknown,
): { token: string } {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match) throw picWorkspaceUnauthorized();
  const queryKeys = query && typeof query === 'object' ? Object.keys(query) : [];
  const bodyKeys =
    body !== undefined && body !== null && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body)
      : [];
  if (queryKeys.length > 0 || bodyKeys.length > 0) {
    throw picWorkspaceRejectsContextError();
  }
  return { token: match[1] };
}
