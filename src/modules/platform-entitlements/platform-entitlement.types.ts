/**
 * CR-BE-SAAS-01 PART 04 — SaaS entitlement platform surface types.
 *
 * Frozen contract §22:
 *   GET  /platform/subscriptions/:id/entitlements (platform.subscription.read)
 *   POST /platform/subscriptions/:id/entitlements (platform.subscription.manage, ver)
 */
import type { EntitlementSource } from '../entitlements';

/** One resolved capability grant for the subscription (frozen §12.1). */
export type PublicSaasEntitlementCapability = {
  /** Canonical `modules` catalogue code. */
  capabilityCode: string;
  /** Effective grants are always enabled; the flag is exposed for the frozen projection shape. */
  enabled: boolean;
  /** Provenance of the effective grant. */
  source: EntitlementSource;
  /** Explicit limit on the grant (null = none on the grant; 0 = unlimited). */
  limit: number | null;
  /** Grant effective period (the entitlement row window, ISO-8601). */
  effectiveFrom: string;
  effectiveUntil: string | null;
};

/** Effective limit DEFINITION from the bound package (frozen §9.4). */
export type PublicSaasEntitlementLimit = {
  limitKey: string;
  limitValue: number;
  unit: string;
  /** Definitions are package-derived; PART 04 exposes no other source. */
  source: 'PACKAGE';
};

/**
 * GET /platform/subscriptions/:id/entitlements — resolved entitlements
 * including limits (frozen §22). `effective` reflects the runtime-usability
 * gate (frozen §12.1: existing `isSubscriptionEffective` + license validity)
 * — the distinction between entitlement EXISTENCE (the rows) and runtime
 * USABILITY under the current subscription state is preserved: capabilities
 * are empty for non-effective subscriptions, while the package limit
 * definitions remain readable as the bound commercial configuration.
 */
export type PublicSaasEntitlementResolved = {
  subscriptionId: string;
  clientId: string;
  subscriptionStatus: string;
  effective: boolean;
  capabilities: PublicSaasEntitlementCapability[];
  limits: PublicSaasEntitlementLimit[];
};

/**
 * POST /platform/subscriptions/:id/entitlements — console OVERRIDE
 * (frozen §22: ver, reason mandatory, audited).
 */
export type OverrideSaasEntitlementInput = {
  /** Capability = the canonical `modules` catalogue code. */
  capabilityCode: string;
  /** true = grant the capability as OVERRIDE; false = withhold it. */
  enabled: boolean;
  /** Explicit limit on the OVERRIDE grant (0 = unlimited; optional). */
  limitValue?: number;
  /** Mandatory (frozen §18.3 — reason is mandatory for overrides). */
  reason: string;
  /** Frozen §17.3 — the subscription's current version (route is "ver"). */
  expectedVersion: number;
};
