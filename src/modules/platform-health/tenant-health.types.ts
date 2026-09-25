/**
 * CR-BE-SAAS-01 PART 10A — Tenant health types (frozen §21.1).
 *
 * Type-only contract surface. No DB / HTTP imports.
 *
 * Contract alignment (frozen):
 *  - Overall status vocabulary is the ONLY multi-valued enum the
 *    contract defines: HEALTHY / DEGRADED / ACTION_REQUIRED / SUSPENDED.
 *    Precedence is exactly: SUSPENDED > ACTION_REQUIRED > DEGRADED >
 *    HEALTHY (clarified in §21.1 by PART 10 contract clarification).
 *  - Components are listed by name only; the contract does NOT define
 *    per-component status values. We model each component with two
 *    frozen boolean flags (degraded, actionRequired) plus an evidence
 *    array of facts/signals derived from canonical sources.
 *  - Per-component source-availability is exposed as `sourceAvailable`
 *    for dimensions whose frozen source has not yet been introduced;
 *    unavailable dimensions MUST NOT contribute to overall derivation.
 *  - Top-level `complete` flag (clarified §21.1): false when any
 *    required frozen component lacks an authoritative source. The
 *    overall status is then NOT considered a fully-assessed HEALTHY.
 */

/** Frozen §21.1 overall status vocabulary. */
export type SaasTenantHealthOverallStatus =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'ACTION_REQUIRED'
  | 'SUSPENDED';

/** Frozen §21.1 components (order is the canonical contract order). */
export type SaasTenantHealthComponent =
  | 'subscription'
  | 'billing'
  | 'provisioning'
  | 'usage_quota'
  | 'configuration_completeness'
  | 'integration_failures'
  | 'notification_failures';

/**
 * The set of components that are REQUIRED by the frozen contract.
 * These are the dimensions the contract always lists; until PART 12
 * wires their authoritative sources, a missing source must surface
 * via the top-level `complete=false` flag rather than silently
 * masquerading as HEALTHY.
 */
export const SAAS_REQUIRED_COMPONENTS: readonly SaasTenantHealthComponent[] =
  [
    'subscription',
    'billing',
    'provisioning',
    'usage_quota',
    'configuration_completeness',
    'integration_failures',
    'notification_failures',
  ] as const;

/** A single frozen-fact signal derived from the canonical source. */
export type SaasTenantHealthEvidence = {
  /** Stable signal key (machine-readable; not user-facing copy). */
  signal:
    | 'subscription.status'
    | 'subscription.near_renewal'
    | 'invoice.overdue'
    | 'invoice.unpaid_past_due'
    | 'provisioning.latest_failed'
    | 'provisioning.latest_running'
    | 'usage.quota_pressure'
    | 'integration.failed_recent'
    | 'notification.failed_recent'
    | 'configuration.branding_missing'
    | 'configuration.required_keys_missing';
  /** Numeric / textual evidence payload. */
  value: string | number | boolean | null;
};

export type SaasTenantHealthComponentReport = {
  component: SaasTenantHealthComponent;
  /** Frozen §21.1 — exactly when the source table says "degraded". */
  degraded: boolean;
  /**
   * Frozen §21.1 — explicit failure signal (FAILED / OVERDUE / SUSPENDED
   * etc.) that the caller must act on. Distinct from `degraded`, which
   * captures warning states (e.g. near-renewal).
   */
  actionRequired: boolean;
  evidence: readonly SaasTenantHealthEvidence[];
  /**
   * True only when a frozen-authoritative source exists for this
   * dimension in the codebase. When false, this component MUST NOT
   * contribute to overall derivation.
   */
  sourceAvailable: boolean;
};

export type SaasTenantHealth = {
  customerId: string;
  overallStatus: SaasTenantHealthOverallStatus;
  components: readonly SaasTenantHealthComponentReport[];
  /**
   * §21.1 contract clarification: false when any required frozen
   * component lacks an authoritative source. The overall HEALTHY
   * value MUST NOT be considered fully-assessed when this is false.
   */
  complete: boolean;
  computedAt: string;
};

/** Frozen §21.1 — quota pressure threshold. */
export const SAAS_QUOTA_PRESSURE_RATIO = 0.9;

/** Frozen §21.1 — near-renewal window (days, explicit in §21.1). */
export const SAAS_NEAR_RENEWAL_DAYS = 7;

/**
 * Frozen §21.1 default failure lookback window when the platform
 * configuration key `saas.health.failure_lookback_days` is absent.
 * PART 10A reads the actual window from that key (default 7 days)
 * — the constant below is the default, not a hardcoded policy.
 */
export const SAAS_HEALTH_FAILURE_LOOKBACK_DAYS_DEFAULT = 7;

/** Frozen configuration key (resolved on read). */
export const SAAS_HEALTH_FAILURE_LOOKBACK_KEY =
  'saas.health.failure_lookback_days';
