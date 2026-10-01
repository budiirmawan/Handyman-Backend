/**
 * CR-HM-01 AMENDMENT 01 PART 07 — Customer Care actor persistence types.
 *
 * Governance: docs/handyman/CR-HM-01_AMENDMENT_01_CUSTOMER_CARE_ACTOR_HANDOFF.md
 * (frozen D4–D8).
 *
 * A Customer Care actor is an authenticated BM-side operator identity that
 * acts ON BEHALF OF a tenant. It is deliberately NOT a local user, NOT a
 * Tenant PIC, and NOT a session: the registry stores no user/PIC/tenant
 * linkage of any kind. Represented tenant/customer and building/unit context
 * travel per handoff assertion and are resolved server-side by the unchanged
 * PART 02 rules; the actor can never widen, skip or substitute them.
 */

export const HANDYMAN_HANDOFF_INTEGRATION_ACTOR_CAPABILITIES = [
  'NONE',
  'CUSTOMER_CARE',
] as const;
export type HandymanHandoffIntegrationActorCapability =
  (typeof HANDYMAN_HANDOFF_INTEGRATION_ACTOR_CAPABILITIES)[number];

export function isHandymanHandoffIntegrationActorCapability(
  value: unknown,
): value is HandymanHandoffIntegrationActorCapability {
  return (
    typeof value === 'string' &&
    (
      HANDYMAN_HANDOFF_INTEGRATION_ACTOR_CAPABILITIES as readonly string[]
    ).includes(value)
  );
}

export const HANDYMAN_CARE_ACTOR_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type HandymanCareActorStatus =
  (typeof HANDYMAN_CARE_ACTOR_STATUSES)[number];

export function isHandymanCareActorStatus(
  value: unknown,
): value is HandymanCareActorStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_CARE_ACTOR_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Opaque, integration-scoped operator reference limit. The reference is never
 * a `users` id, a `tenant_pics` id, or a token: it is meaningful only inside
 * the attesting BM integration.
 */
export const HANDYMAN_CARE_ACTOR_REFERENCE_MAX_LENGTH = 128;
export const HANDYMAN_CARE_ACTOR_DISPLAY_NAME_MAX_LENGTH = 160;

/** Integration trust metadata plus its (PART 07) actor-capability scope. */
export type HandymanHandoffIntegrationActorScope = {
  integrationId: string;
  integrationCode: string;
  displayName: string;
  status: 'ACTIVE' | 'INACTIVE';
  /** 'NONE' for every pre-amendment/legacy integration row. */
  actorCapability: HandymanHandoffIntegrationActorCapability;
};

/** Registry record. There is no delete lifecycle — only ACTIVE/INACTIVE. */
export type HandymanCareActorRecord = {
  id: string;
  integrationId: string;
  actorReference: string;
  displayName: string;
  status: HandymanCareActorStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicHandymanCareActor = Omit<
  HandymanCareActorRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

/** Operational provisioning input (server-side only; never an assertion). */
export type CreateHandymanCareActorInput = {
  integrationId: string;
  actorReference: string;
  displayName: string;
};

/**
 * PART 08 — closed actor-type vocabulary. Only `CUSTOMER_CARE` exists; any
 * other value fails closed (never ignored, never downgraded to legacy).
 */
export const HANDYMAN_CARE_ACTOR_TYPE = 'CUSTOMER_CARE' as const;
export type HandymanCareActorType = typeof HANDYMAN_CARE_ACTOR_TYPE;

/** Structural shape of the signed `actor` block carried by an assertion. */
export type HandoffCareActorClaim = {
  type: HandymanCareActorType;
  actorReference: string;
};

/** Resolver input: the authenticated integration plus the untrusted claim. */
export type ResolveCareActorClaimInput = {
  /**
   * Integration code the handoff layer authenticated (signature scope). It is
   * re-resolved here against the registry — never assumed trustworthy.
   */
  integrationCode: string;
  /** Raw, untrusted actor block from the assertion payload. */
  actorClaim: unknown;
};

/**
 * AUTHORITATIVE server-derived actor provenance (PART 08). Contains registry
 * identity only: it is deliberately NOT a local user, NOT a Tenant PIC, and
 * NOT a session, and it grants no business authorization by itself.
 */
export type ResolvedCareActorProvenance = Readonly<{
  actorType: HandymanCareActorType;
  /** Registry row id — the only actor identity downstream PARTs may record. */
  careActorId: string;
  /** Integration the actor is scoped to (attestation scope). */
  integrationId: string;
  integrationCode: string;
  actorReference: string;
}>;
