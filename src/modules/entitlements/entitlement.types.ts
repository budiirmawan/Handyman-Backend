/**
 * BE-02C — Module Entitlement domain types.
 *
 * The commercial relationship Subscription → Entitlement → Module. It answers
 * "what modules/capabilities has this Client commercially enabled through its
 * valid Subscription?" It does NOT answer "what may a User do" (BE-01
 * Permission).
 *
 * CR-BE-SAAS-01 PART 04 (frozen contract §12.1): the record gains `source`
 * (grant provenance) and nullable `limitValue` (explicit limit on the grant;
 * 0 = unlimited, NULL = not explicitly set). Legacy rows are MANUAL.
 */
export const ENTITLEMENT_STATUSES = ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED'] as const;

export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

export function isEntitlementStatus(value: unknown): value is EntitlementStatus {
  return (
    typeof value === 'string' &&
    (ENTITLEMENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Frozen §12.1 grant-provenance vocabulary (full set stored for
 * future-compatibility; PART 04 writes only PACKAGE and OVERRIDE, legacy
 * rows read as MANUAL).
 */
export const ENTITLEMENT_SOURCES = [
  'PACKAGE',
  'ADD_ON',
  'OVERRIDE',
  'PROMOTION',
  'MANUAL',
] as const;

export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

export function isEntitlementSource(value: unknown): value is EntitlementSource {
  return (
    typeof value === 'string' &&
    (ENTITLEMENT_SOURCES as readonly string[]).includes(value)
  );
}

export type EntitlementRecord = {
  id: string;
  subscriptionId: string;
  moduleId: string;
  status: EntitlementStatus;
  startsAt: Date;
  endsAt: Date | null;
  /** PART 04: grant provenance (frozen §12.1). Legacy rows = MANUAL. */
  source: EntitlementSource;
  /**
   * PART 04: explicit limit on this grant. NULL = not explicitly set (the
   * resolution chain falls through to the package limit definitions);
   * 0 = explicitly unlimited (frozen §12.1).
   */
  limitValue: number | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicEntitlement = {
  id: string;
  subscriptionId: string;
  moduleId: string;
  status: EntitlementStatus;
  startsAt: Date;
  endsAt: Date | null;
  /** PART 04 (additive): grant provenance. */
  source: EntitlementSource;
  /** PART 04 (additive): explicit limit (null = not explicitly set). */
  limitValue: number | null;
};

export type CreateEntitlementInput = {
  moduleId: string;
  startsAt: Date;
  endsAt?: Date;
  status?: EntitlementStatus;
};

/** Fully-resolved entitlement data ready for persistence. */
export type NewEntitlement = {
  subscriptionId: string;
  moduleId: string;
  status: EntitlementStatus;
  startsAt: Date;
  endsAt: Date | null;
  /** PART 04: grant provenance (defaults to MANUAL for legacy callers). */
  source?: EntitlementSource;
  /** PART 04: explicit limit (null/undefined = not explicitly set). */
  limitValue?: number | null;
};

export type UpdateEntitlementStatusInput = {
  status: EntitlementStatus;
};

/**
 * Safe summary of an effectively-entitled Module for a Subscription.
 *
 * PART 04 (frozen §12.1, "resolver extended, never replaced"): the existing
 * BE-02C summary is extended additively with the grant's provenance, its
 * explicit limit (null = none on the grant), and its effective period.
 */
export type EffectiveModuleSummary = {
  moduleId: string;
  code: string;
  name: string;
  /** PART 04: provenance of the effective grant. */
  source: EntitlementSource;
  /** PART 04: explicit limit on the grant (null = none on the grant). */
  limit: number | null;
  /** PART 04: grant effective period (the entitlement row window). */
  effectiveFrom: Date;
  effectiveUntil: Date | null;
};

/**
 * PART 04 — console override command (frozen §22:
 * `POST /platform/subscriptions/:id/entitlements`, ver, reason mandatory,
 * audited `SAAS_ENTITLEMENT_OVERRIDDEN`).
 */
export type OverrideEntitlementInput = {
  /** Capability = the canonical `modules` catalogue code. */
  capabilityCode: string;
  /** true = grant the capability as OVERRIDE; false = withhold it. */
  enabled: boolean;
  /** Explicit limit on the OVERRIDE grant (0 = unlimited; optional). */
  limitValue?: number;
  /** Mandatory (frozen §18.3 — reason is mandatory for overrides). */
  reason: string;
};
