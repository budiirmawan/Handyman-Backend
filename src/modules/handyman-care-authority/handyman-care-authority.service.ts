import { resolveBuildingsForUser } from '../building-assignments';
import { permissionService } from '../permissions';
import { userRepository } from '../users';
import { careAuthorityDeniedError } from './handyman-care-authority.errors';
import {
  CARE_AUTHORITY_ROLE,
  HANDYMAN_CARE_BUILDING_PERMISSION,
  type BuildingCareAuthority,
  type ResolveBuildingCareAuthorityInput,
} from './handyman-care-authority.types';

/**
 * CR-HM-BM-CARE-AUTH-01 — Building Customer Care authority resolver
 * (Authority A).
 *
 * Business baseline: TENANT/PIC ↔ CUSTOMER CARE BUILDING ↔ HANDYMAN.
 *
 * WHAT THIS ESTABLISHES (Authority A):
 *   who the authenticated Care actor is, and which exact Building that actor
 *   may mediate.
 *
 * WHAT THIS DOES NOT ESTABLISH (Authority B — blocked):
 *   whether a Tenant approved a Quotation, a Variation or a BAST. Care
 *   decision recording stays disabled; see `DECISION_AUTHORITY_BLOCKED`.
 *
 * The resolution chain is entirely server-side and fail-closed. It reuses
 * the existing canonical mechanisms rather than inventing a parallel one:
 *
 *   1. AUTHENTICATED REAL CARE ACTOR — `actorUserId` must come from the
 *      Backend session (`req.auth.userId`). The account must exist and be
 *      ACTIVE; INVITED / INACTIVE / SUSPENDED accounts are denied. No Care
 *      identity is minted, inferred or defaulted.
 *
 *   2. EXPLICIT CARE PERMISSION — the actor's effective permissions (BE-01E
 *      resolver, the single source of truth) must include the dedicated
 *      `handyman.care.building` capability. Generic `tenant_company.manage`
 *      is NOT consulted and is NOT a substitute: it is a tenant-company
 *      administration capability with a different blast radius, and holding
 *      it must never imply the Care bridge.
 *
 *   3. ACTIVE ASSIGNMENT TO THE EXACT BUILDING — reuse of BE-02F
 *      `resolveBuildingsForUser`, which already filters to ACTIVE
 *      `user_building_assignments` AND ACTIVE buildings. A revoked,
 *      deactivated or never-granted assignment simply is not in the set, so
 *      "inactive or revoked Building assignment" needs no second rule.
 *
 *   4. CORRECT COMPANY/CLIENT/BUILDING SCOPE — the Client is derived from
 *      the actor's OWN assignment chain (Building → Property → Client) and
 *      never from the request. A caller-supplied Client can only be checked
 *      against the derived one; it can never widen or redirect the scope.
 *      There is no same-Client sibling shortcut: the match is on the exact
 *      Building id.
 *
 *   5. NO CARE IMPERSONATION OF TENANT/PIC — `tenant_pics` is never read and
 *      no Tenant/PIC identifier is ever returned. The authority shape cannot
 *      carry one (`capabilities.mayActAsTenantPic` is a `false` literal), so
 *      the bridge can never present itself as the Tenant.
 *
 * BM CARE AUTHENTICATION BOUNDARY — EXPLICIT LIMITATION:
 *   The BM Super App Care actor registry is real and integration-signed
 *   (migrations 0425-0430, `resolveCareActorClaim` in
 *   `modules/handyman-care-actors`). It is NOT connected to Backend session
 *   authentication: those rows carry no local user, no session and no
 *   Building assignment, so they cannot express Building reach. This
 *   resolver therefore reports `bmCareActorBinding: null` and authorizes on
 *   the Backend session alone. It never fabricates a Care identity from the
 *   BM registry and never authorizes a generic user as Care.
 */

/** The dedicated capability that gates the Care bridge. */
export { HANDYMAN_CARE_BUILDING_PERMISSION };

/**
 * The generic capability that must NEVER stand in for the Care bridge.
 * Exported so tests and reviewers can assert the substitution is refused
 * rather than merely untested.
 */
export const GENERIC_TENANT_COMPANY_MANAGE_PERMISSION = 'tenant_company.manage';

/**
 * Why Authority B is still blocked. Surfaced in every response so the
 * frontend renders a truthful disabled state instead of inventing one.
 */
export const DECISION_AUTHORITY_BLOCKED = {
  status: 'BLOCKED',
  reason:
    'Authority B (whether a Tenant approved a Quotation, Variation or BAST) ' +
    'is unresolved. It requires both a decided commercial-decision authority ' +
    'and a verified evidence contract. Until both are sufficient, ' +
    'POST /handyman/care-decisions remains disabled and no Care decision is ' +
    'recorded or propagated as a commercial mutation (SD-17).',
  endpoint: '/handyman/care-decisions',
  method: 'POST',
} as const;

/**
 * Identity fields a client may attempt to supply in order to choose who is
 * recorded as the actor. None is ever honoured (SD-19); presenting one is a
 * rejected request, not a silently-ignored one.
 */
export const NON_ACCEPTED_IDENTITY_FIELDS: readonly string[] = [
  'recordedByUserId',
  'recorded_by_user_id',
  'actorUserId',
  'actor_user_id',
  'careActorId',
  'care_actor_id',
  'tenantPicId',
  'tenant_pic_id',
  'tenantId',
  'tenant_id',
];

/**
 * Resolves Authority A, or fails closed with the single non-enumerating
 * `HANDYMAN_CARE_AUTHORITY_DENIED`.
 *
 * Read-only: it performs no mutation of any quotation, variation, BAST,
 * tenant or Care row, and it opens no transaction.
 */
async function resolveActiveBuildingCareActor(
  actorUserId: string | null | undefined,
) {
  if (typeof actorUserId !== 'string' || actorUserId.length === 0) {
    throw careAuthorityDeniedError();
  }

  const user = await userRepository.findById(actorUserId);
  if (!user || user.status !== 'ACTIVE') {
    throw careAuthorityDeniedError();
  }

  const permissions =
    await permissionService.resolvePermissionsForUser(actorUserId);
  if (!permissions.includes(HANDYMAN_CARE_BUILDING_PERMISSION)) {
    throw careAuthorityDeniedError();
  }

  return user;
}

/**
 * Reusable identity + dedicated-capability check for Building Care reads
 * whose scope is a list rather than one selected Building. Assignment and
 * Client/Property/Building lineage must still be resolved separately.
 */
export async function assertBuildingCareActor(
  actorUserId: string | null | undefined,
): Promise<void> {
  await resolveActiveBuildingCareActor(actorUserId);
}

export async function resolveBuildingCareAuthority(
  input: ResolveBuildingCareAuthorityInput,
): Promise<BuildingCareAuthority> {
  // (1)+(2) Authenticated active Backend actor with the dedicated capability.
  const actorUserId = input?.actorUserId;
  const user = await resolveActiveBuildingCareActor(actorUserId);

  // (3)+(4) ACTIVE assignment to the EXACT Building, under the Client the
  // Backend derives from the actor's own assignment.
  const buildingId = input.buildingId;
  if (typeof buildingId !== 'string' || buildingId.length === 0) {
    throw careAuthorityDeniedError();
  }

  const contexts = await resolveBuildingsForUser(user.id);
  const context = contexts.find((entry) => entry.building.id === buildingId);
  if (!context) {
    throw careAuthorityDeniedError();
  }

  const clientId = context.client?.id ?? null;
  if (!clientId) {
    // A Building with no resolvable Client cannot establish company scope.
    throw careAuthorityDeniedError();
  }

  const assertedClientId = input.assertedClientId ?? null;
  if (assertedClientId !== null && assertedClientId !== clientId) {
    throw careAuthorityDeniedError();
  }

  // (5) No Tenant/PIC identity is resolved, and none can be returned.
  return Object.freeze({
    role: CARE_AUTHORITY_ROLE,
    actor: {
      userId: user.id,
      displayName: user.displayName,
      email: user.email,
    },
    grantedByPermission: HANDYMAN_CARE_BUILDING_PERMISSION,
    scope: Object.freeze({
      clientId,
      clientCode: context.client?.code ?? null,
      propertyId: context.property?.id ?? null,
      buildingId: context.building.id,
      buildingCode: context.building.code,
      buildingName: context.building.name,
      assignmentId: context.id,
    }),
    capabilities: Object.freeze({
      mayMediateBuildingCare: true as const,
      mayRecordCareDecision: false as const,
      mayApproveQuotation: false as const,
      mayApproveVariation: false as const,
      mayAcceptBast: false as const,
      mayActAsTenantPic: false as const,
    }),
    identitySource: 'BACKEND_SESSION' as const,
    bmCareActorBinding: null,
    decisionAuthority: DECISION_AUTHORITY_BLOCKED,
  });
}

/**
 * Assertion form for reuse by future Care routes. Fails closed with the same
 * single non-enumerating denial.
 */
export async function assertBuildingCareAuthority(
  input: ResolveBuildingCareAuthorityInput,
): Promise<BuildingCareAuthority> {
  return resolveBuildingCareAuthority(input);
}

export const buildingCareAuthorityService = {
  assertBuildingCareActor,
  assertBuildingCareAuthority,
  resolveBuildingCareAuthority,
};
