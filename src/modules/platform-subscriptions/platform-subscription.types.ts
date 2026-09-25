/**
 * CR-BE-SAAS-01 PART 03 — SaaS Subscription aggregate types (SaaS Control
 * Plane).
 *
 * The canonical SaaS Subscription IS the existing `subscriptions` row
 * (frozen contract §6/§11.1 — the 0013 foundation, extended by 0364).
 * Legacy rows (business-plane `plan_code` era) remain valid; the canonical
 * §11.2 vocabulary is layered on top without rewriting any row.
 */

/** Canonical §11.2 status vocabulary (server-authoritative). */
export const SAAS_SUBSCRIPTION_STATUSES = [
  'DRAFT',
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'GRACE',
  'SUSPENDED',
  'CANCELLED',
  'TERMINATED',
] as const;

export type SaasSubscriptionStatus =
  (typeof SAAS_SUBSCRIPTION_STATUSES)[number];

/**
 * Every status value the `subscriptions.status` column may hold: the
 * canonical §11.2 vocabulary plus the two legacy values kept for
 * compatibility (frozen decision D6: readable, never newly written).
 */
export const SAAS_SUBSCRIPTION_STORAGE_STATUSES = [
  ...SAAS_SUBSCRIPTION_STATUSES,
  'PENDING',
  'EXPIRED',
] as const;

export type SaasSubscriptionStorageStatus =
  (typeof SAAS_SUBSCRIPTION_STORAGE_STATUSES)[number];

export function isSaasSubscriptionStatus(
  value: unknown,
): value is SaasSubscriptionStatus {
  return (
    typeof value === 'string' &&
    (SAAS_SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isSaasSubscriptionStorageStatus(
  value: unknown,
): value is SaasSubscriptionStorageStatus {
  return (
    typeof value === 'string' &&
    (SAAS_SUBSCRIPTION_STORAGE_STATUSES as readonly string[]).includes(value)
  );
}

/** `TERMINATED` is the single irreversible terminal state (§11.2). */
export const SAAS_SUBSCRIPTION_TERMINAL_STATUSES = [
  'TERMINATED',
] as const;

export type BillingCycle = 'MONTHLY' | 'ANNUAL' | 'CUSTOM';

export const SAAS_SUBSCRIPTION_BILLING_CYCLES: readonly BillingCycle[] = [
  'MONTHLY',
  'ANNUAL',
  'CUSTOM',
];

export function isSaasSubscriptionBillingCycle(
  value: unknown,
): value is BillingCycle {
  return (
    typeof value === 'string' &&
    (SAAS_SUBSCRIPTION_BILLING_CYCLES as readonly string[]).includes(value)
  );
}

/** Persisted aggregate (the `subscriptions` row, 0013 + 0364). */
export type SaasSubscriptionRecord = {
  id: string;
  clientId: string;
  /** Stable unique business identifier (server-generated: `SUB-YYYY-…`). */
  code: string;
  /**
   * Legacy informational column (frozen §11.1): new SaaS writes fill it as
   * a display alias of the package code — never a driver of entitlement.
   */
  planCode: string;
  productId: string | null;
  packageId: string | null;
  /** Immutable commercial snapshot reference (frozen §11.1/§10.4). */
  pricebookVersionId: string | null;
  billingCycle: BillingCycle | null;
  currencyCode: string | null;
  status: SaasSubscriptionStorageStatus;
  startsAt: Date;
  /** Legacy period end (business-plane rows); SaaS rows keep it NULL. */
  endsAt: Date | null;
  trialEndDate: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  renewalDate: Date | null;
  graceUntil: Date | null;
  cancelledAt: Date | null;
  terminatedAt: Date | null;
  /** Optimistic-concurrency guard (frozen §17.3, D5). */
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Commercial binding resolved from the referenced commercial records. */
export type CommercialBinding = {
  product: { id: string; code: string };
  package: { id: string; code: string };
  pricebookVersion: {
    id: string;
    pricebookId: string;
    versionNumber: number;
    status: string;
  };
  pricebook: { id: string; code: string | null };
  item: {
    id: string;
    currencyCode: string;
    billingCycle: BillingCycle;
    basePrice: number;
    includedBuildingCount: number;
    additionalBuildingPrice: number;
  };
};

/**
 * Public projection of the aggregate. Dates are ISO-8601 strings. Legacy
 * SaaS columns are `null` on pre-PART-03 rows.
 */
export type PublicSaasSubscription = {
  id: string;
  clientId: string;
  code: string;
  planCode: string;
  productId: string | null;
  packageId: string | null;
  pricebookVersionId: string | null;
  billingCycle: BillingCycle | null;
  currencyCode: string | null;
  status: SaasSubscriptionStorageStatus;
  startsAt: string;
  endsAt: string | null;
  trialEndDate: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  renewalDate: string | null;
  graceUntil: string | null;
  cancelledAt: string | null;
  terminatedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * The full aggregate read (frozen §22: "full aggregate + version") plus the
 * commercial reference resolved from the BOUND (historical) pricebook
 * version — never the current/latest one (frozen §10.4 price resolution).
 * All `commercial.*` fields are null on legacy rows.
 */
export type PublicSaasSubscriptionDetail = PublicSaasSubscription & {
  commercial: {
    productCode: string | null;
    packageCode: string | null;
    pricebookCode: string | null;
    versionNumber: number | null;
    versionStatus: string | null;
    item: {
      billingCycle: BillingCycle;
      currencyCode: string;
      basePrice: number;
      includedBuildingCount: number;
      additionalBuildingPrice: number;
    } | null;
  };
};

export type ListSaasSubscriptionFilters = {
  /** Query param `customerId` (§22). */
  customerId?: string;
  status?: SaasSubscriptionStorageStatus;
  /** Query param `packageId` (§22). */
  packageId?: string;
};

// ---------------------------------------------------------------------------
// Command inputs (parsed/validated; the service re-checks state rules)
// ---------------------------------------------------------------------------

export type CreateSaasSubscriptionInput = {
  clientId: string;
  productId: string;
  packageId: string;
  pricebookVersionId: string;
  billingCycle: BillingCycle;
  /** Must match the bound price item's currency (frozen §10.3). */
  currencyCode?: string;
  /** Trial metadata: sets the §11.2 trial window end (future date). */
  trialEndDate?: string;
};

export type UpdateSaasSubscriptionInput = {
  /** Frozen §22: non-status fields only — renewal date, trial end. */
  renewalDate?: string;
  trialEndDate?: string;
  expectedVersion: number;
};

export type ActivateSaasSubscriptionInput = {
  /** TRIAL → DRAFT→TRIAL; PAID → DRAFT→ACTIVE (frozen §11.2). */
  mode: 'TRIAL' | 'PAID';
  /** TRIAL mode: required; must be a future timestamp. */
  trialEndDate?: string;
  /** PAID mode: period dates (defaults derived from the billing cycle). */
  periodStart?: string;
  periodEnd?: string;
  renewalDate?: string;
};

export type ConvertSaasSubscriptionInput = {
  /** TRIAL→ACTIVE period dates (defaults derived from the billing cycle). */
  periodStart?: string;
  periodEnd?: string;
  renewalDate?: string;
};

export type RenewSaasSubscriptionInput = {
  /**
   * Required for `CUSTOM` billing cycles (§11.3); must be after the
   * extended period start.
   */
  periodEnd?: string;
  /**
   * Deliberate commercial change: rebind to another published version
   * (frozen §11.3) — `reason` becomes mandatory when this is carried.
   */
  pricebookVersionId?: string;
  reason?: string;
  expectedVersion: number;
};

export type CancelSaasSubscriptionInput = {
  /** Mandatory (frozen §22). */
  reason: string;
  /** true → service ends now; false (default) → end of current period. */
  immediate?: boolean;
  expectedVersion: number;
};

export type TerminateSaasSubscriptionInput = {
  /** Mandatory (frozen §22). */
  reason: string;
  expectedVersion: number;
};
