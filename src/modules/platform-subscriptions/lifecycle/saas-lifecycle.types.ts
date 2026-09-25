/**
 * CR-BE-SAAS-01 PART 08 — Lifecycle types (frozen §11.4, §11.5, §16, §20).
 *
 * Type-only contract surface for the grace/suspension/reactivation service.
 * No DB or HTTP imports — kept test-friendly.
 */

/** Frozen §20.2 / §12.2.3 — values of `saas.suspended_access_policy`. */
export type SaasSuspendedAccessPolicy =
  | 'READ_ONLY'
  | 'LIMITED_ACCESS'
  | 'FULL_BLOCK';

/**
 * Frozen §11.5 — reactivation prerequisites. The override branch is the
 * one case where a manual authorisation can lift the "billing resolved"
 * precondition; the structured `overrideReason` is mandatory-audit and
 * NEVER silently bypasses.
 */
export type SaasReactivationOverrideReason = string;

export type ReactivateSaasSubscriptionInput = {
  /** Frozen §17.3 OCC. */
  expectedVersion: number;
  /**
   * Contract adjustment / authorised override (frozen §11.5.2). MUST be
   * supplied when `outstandingInvoiceIds.length > 0`. Empty / whitespace
   * strings are rejected by the validator.
   */
  overrideReason?: string;
};

export type SweepBillingInput = {
  /**
   * Deterministic cutoff (canonical server time). When the route is
   * called by the future scheduler this defaults to `NOW()`; tests
   * inject a fixed cutoff so the boundary suite is repeatable.
   */
  cutoff?: Date;
  /**
   * Cap the number of subscriptions touched in one call. Prevents a
   * single sweep from monopolising a worker. Default 200.
   */
  limit?: number;
};

export type SweepBillingResult = {
  cutoff: string;
  overdueInvoicesMarked: number;
  pastDueTransitions: number;
  graceTransitions: number;
  suspendedTransitions: number;
  touchedSubscriptionIds: string[];
  noOp: boolean;
};

export type SuspendViaSweepInput = {
  subscriptionId: string;
  expectedVersion: number;
  reason: string;
};

export type ReactivateSaasSubscriptionResult = {
  subscription: import('../platform-subscription.types').PublicSaasSubscription;
  overrideApplied: boolean;
  customerStatusBefore: string | null;
  customerStatusAfter: string | null;
};
