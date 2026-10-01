import { handoffAssertionInvalidError } from '../handyman-handoff/handoff-runtime.errors';
import { handymanCareActorRepository } from './handyman-care-actor.repository';
import {
  HANDYMAN_CARE_ACTOR_REFERENCE_MAX_LENGTH,
  HANDYMAN_CARE_ACTOR_TYPE,
  isHandymanCareActorStatus,
  type HandoffCareActorClaim,
  type ResolveCareActorClaimInput,
  type ResolvedCareActorProvenance,
} from './handyman-care-actor.types';

/**
 * CR-HM-01 AMENDMENT 01 PART 08 — attested Customer Care actor resolver.
 *
 * Pure, side-effect-free application service: it turns an UNTRUSTED actor
 * block (covered by the integration signature in PART 09) into canonical,
 * server-derived provenance, or it fails closed. It performs reads only — no
 * persistence writes, no exchange, no attribution, no session/RBAC, and no
 * notification of any kind.
 *
 * Resolution chain (all server-side, in order):
 *   1. structural validation of the actor block (closed shape, closed type);
 *   2. integration must exist and be ACTIVE;
 *   3. integration must hold the CUSTOMER_CARE actor capability;
 *   4. an ACTIVE registry row must exist for the SAME integration and the
 *      SAME `actor_reference`.
 *
 * Failure semantics (governance amendment §3.3): unknown integration,
 * inactive integration, incapable integration, unknown actor, inactive actor,
 * actor of ANOTHER integration, and every structural defect all collapse into
 * the SAME already-existing non-enumerating 401
 * `HANDYMAN_HANDOFF_ASSERTION_INVALID` (no new error surface, no logging of
 * the claim, no hint whether an integration/actor exists anywhere).
 *
 * Authority note: the returned provenance is registry identity ONLY. The
 * resolver never resolves to a local User or a Tenant PIC (`tenant_pics.userId`
 * is neither read nor fabricated), and a resolved actor grants no business
 * authorization — represented tenant/building/unit context stays the
 * unchanged PART 02 resolution, and the actor can never widen it.
 */

const CLAIM_KEYS: readonly string[] = ['type', 'actorReference'];

/**
 * Validates the closed actor block. Unknown members fail closed (no smuggled
 * semantics); `type` must be exactly CUSTOMER_CARE; the reference must be a
 * bounded, non-blank string. Returns the canonical (trimmed) reference, or
 * null for every defect — the caller collapses all of them into one failure.
 */
function readActorClaim(claim: unknown): HandoffCareActorClaim | null {
  if (typeof claim !== 'object' || claim === null || Array.isArray(claim)) {
    return null;
  }
  const record = claim as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== CLAIM_KEYS.length ||
    !keys.every((key) => CLAIM_KEYS.includes(key))
  ) {
    return null;
  }
  if (record.type !== HANDYMAN_CARE_ACTOR_TYPE) return null;
  const reference =
    typeof record.actorReference === 'string' ? record.actorReference.trim() : '';
  if (
    reference.length === 0 ||
    reference.length > HANDYMAN_CARE_ACTOR_REFERENCE_MAX_LENGTH
  ) {
    return null;
  }
  return { type: HANDYMAN_CARE_ACTOR_TYPE, actorReference: reference };
}

/**
 * Resolves an actor claim to authoritative provenance, or fails closed with
 * the single non-enumerating assertion failure. Never logs the claim.
 */
export async function resolveCareActorClaim(
  input: ResolveCareActorClaimInput,
): Promise<ResolvedCareActorProvenance> {
  const claim = readActorClaim(input?.actorClaim);
  if (!claim) throw handoffAssertionInvalidError();

  const integrationCode =
    typeof input.integrationCode === 'string' ? input.integrationCode : '';
  if (integrationCode.length === 0) throw handoffAssertionInvalidError();

  const integration =
    await handymanCareActorRepository.findIntegrationActorScopeByCode(
      integrationCode,
    );
  if (
    !integration ||
    integration.status !== 'ACTIVE' ||
    integration.actorCapability !== HANDYMAN_CARE_ACTOR_TYPE
  ) {
    throw handoffAssertionInvalidError();
  }

  const actor = await handymanCareActorRepository
    .findActiveByIntegrationAndReference(
      integration.integrationId,
      claim.actorReference,
    );
  if (
    !actor ||
    actor.integrationId !== integration.integrationId ||
    !isHandymanCareActorStatus(actor.status) ||
    actor.status !== 'ACTIVE'
  ) {
    throw handoffAssertionInvalidError();
  }

  return Object.freeze({
    actorType: HANDYMAN_CARE_ACTOR_TYPE,
    careActorId: actor.id,
    integrationId: integration.integrationId,
    integrationCode: integration.integrationCode,
    actorReference: actor.actorReference,
  });
}

export const handymanCareActorResolver = {
  resolveCareActorClaim,
};
