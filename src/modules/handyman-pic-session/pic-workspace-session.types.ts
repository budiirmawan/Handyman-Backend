/**
 * W03 PART 03C — bounded Tenant PIC session types (A01 §4–§5, rules 1–22).
 *
 * Every field below is either (a) a value BM asserted and Handyman then
 * RE-RESOLVED, or (b) a server-derived identity. Nothing here is authority a
 * caller can supply: the representation names the context to resolve, and the
 * resolution decides whether the admission happens at all.
 */

/** Rule 2 — purpose isolation. This literal is checked BEFORE anything else. */
export const PIC_WORKSPACE_PURPOSE = 'HANDYMAN_PIC_WORKSPACE';

/**
 * Rule 14 — the prefix separates credential KINDS in logs and rejects obvious
 * cross-kind use early. It is a convenience, never the authority: the authority
 * is that PIC sessions live in their own table and are only ever looked up
 * there (rule 19, no fallback).
 */
export const PIC_WORKSPACE_TOKEN_PREFIX = 'hpw_';
export const PIC_WORKSPACE_TOKEN_PATTERN = /^hpw_[A-Za-z0-9_-]{43}$/;

/** Rule 15 — the contract ceiling. Not a per-request claim: `ttlSeconds` is a
 * deployment knob (see `readPicWorkspaceRuntimeConfig`) and no input field of
 * any endpoint can lengthen or shorten a session. */
export const PIC_WORKSPACE_MAX_TTL_SECONDS = 900;
export const PIC_WORKSPACE_DEFAULT_TTL_SECONDS = 900;

/** Rule 4 — the assertion's own validity window is shorter than the session's. */
export const PIC_WORKSPACE_ASSERTION_MAX_WINDOW_MS = 300_000;

/** Rule 2 — exact payload key set. A missing or unknown key is a 401. */
export const PIC_WORKSPACE_ASSERTION_KEYS = [
  'purpose',
  'integrationCode',
  'assertionId',
  'issuedAt',
  'expiresAt',
  'representation',
] as const;

/**
 * Rule 3 — the same field names and resolution rules as the existing handoff
 * context (no new claim vocabulary), so `resolveHandoffContext` stays the only
 * occupancy master. `tenantPicId` is optional: an admission without one is a
 * read-capable session and can never underwrite a decision.
 */
export const PIC_WORKSPACE_REPRESENTATION_KEYS = [
  'tenantCompanyId',
  'buildingId',
  'tenantPicId',
  'spaceId',
] as const;
export const PIC_WORKSPACE_REPRESENTATION_REQUIRED_KEYS = [
  'tenantCompanyId',
  'buildingId',
] as const;

export type PicWorkspaceRepresentation = {
  tenantCompanyId: string;
  buildingId: string;
  tenantPicId?: string;
  spaceId?: string;
};

export type PicWorkspaceAssertion = {
  purpose: typeof PIC_WORKSPACE_PURPOSE;
  integrationCode: string;
  assertionId: string;
  issuedAt: string;
  expiresAt: string;
  representation: PicWorkspaceRepresentation;
};

/** Rule 1 (A1): admission returns the credential and its expiry, nothing else. */
export type PicWorkspaceAdmissionResult = {
  workspaceToken: string;
  expiresAt: string;
};

/**
 * The resolved PIC principal. Deliberately has no user id and no permission
 * snapshot (A2, rule 10): a PIC is not a staff user and the absence of a
 * `users` id is a valid state, never something to fabricate around.
 */
export type PicWorkspacePrincipal = Readonly<{
  actorType: 'TENANT_PIC';
  sessionId: string;
  integrationId: string;
  tenantCompanyId: string;
  tenantPicId: string | null;
  buildingId: string;
  spaceId: string | null;
  tenantBuildingContextId: string;
  /**
   * Rule 3's read/decide split, derived from the credential itself rather than
   * from a caller. `03E` must refuse to decide when this is false; it is not a
   * display flag — it is the only representation of that rule at this layer.
   */
  canDecide: boolean;
  issuedAt: string;
  expiresAt: string;
}>;

/** Public introspection projection (rule 14: no token, no hash, no secret). */
export type PublicPicWorkspaceSession = {
  sessionId: string;
  tenantCompanyId: string;
  tenantPicId: string | null;
  buildingId: string;
  spaceId: string | null;
  canDecide: boolean;
  issuedAt: string;
  expiresAt: string;
};

export function toPublicPicWorkspaceSession(
  principal: PicWorkspacePrincipal,
): PublicPicWorkspaceSession {
  return {
    sessionId: principal.sessionId,
    tenantCompanyId: principal.tenantCompanyId,
    tenantPicId: principal.tenantPicId,
    buildingId: principal.buildingId,
    spaceId: principal.spaceId,
    canDecide: principal.canDecide,
    issuedAt: principal.issuedAt,
    expiresAt: principal.expiresAt,
  };
}

export type PicWorkspaceRuntimeConfig = {
  ttlSeconds: number;
};

/**
 * BLK-8 (TTL/UX bound) is an OPEN owner decision, so the ceiling the contract
 * allows is what ships, and the shortest-TTL preference stays a deployment
 * knob rather than an invented constant. A value above 900 is clamped, not
 * honoured: the DB CHECK in `0441` would refuse the row anyway, and failing at
 * configuration time is better than failing at admission time.
 */
export function readPicWorkspaceRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): PicWorkspaceRuntimeConfig {
  const raw = env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  const ttl = Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, PIC_WORKSPACE_MAX_TTL_SECONDS)
    : PIC_WORKSPACE_DEFAULT_TTL_SECONDS;
  return { ttlSeconds: Math.min(ttl, PIC_WORKSPACE_MAX_TTL_SECONDS) };
}
