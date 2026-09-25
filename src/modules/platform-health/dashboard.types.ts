/**
 * CR-BE-SAAS-01 PART 10B — Commercial dashboard types (frozen §21.2).
 *
 * Type-only contract surface. No DB / HTTP imports.
 *
 * Response shape mirrors §21.2 documented formulas exactly. No FX
 * conversion; per-currency buckets only (frozen CR-BE-FX-01 boundary).
 */

/** Per-currency monetary bucket. */
export type SaasCommercialCurrencyBucket = {
  currencyCode: string;
  amount: string; // NUMERIC string
};

/** Subscription lifecycle status counts (frozen §21.2). */
export type SaasCommercialSubscriptionCounts = {
  active: number;
  pastDue: number;
  suspended: number;
};

/** Customer lifecycle status counts (frozen §21.2). */
export type SaasCommercialCustomerCounts = {
  active: number;
  trial: number;
};

/** Health counts (PART 10A derived from `complete`-aware overall). */
export type SaasCommercialHealthCounts = {
  healthy: number;
  degraded: number;
  actionRequired: number;
  suspended: number;
  /**
   * Frozen PART 10 contract clarification: customers whose projection
   * has `complete = false` (a required component source is missing).
   * MUST NOT be counted as `healthy`. PART 10B exposes this so the
   * console cannot represent them as fully-assessed HEALTHY.
   */
  incomplete: number;
};

/** Per-customer outstanding invoice totals. */
export type SaasCommercialOutstandingBucket = {
  currencyCode: string;
  amount: string;
};

/** Bucket by invoice age (frozen §21.2 collectionStatus). */
export type SaasCommercialCollectionBucket = {
  current: number;
  age1to30: number;
  age31to60: number;
  ageOver60: number;
};

/** Per-customer building count (frozen §21.2 buildingsUnderSubscription). */
export type SaasCommercialBuildingsEntry = {
  customerId: string;
  customerCode: string;
  buildings: number;
};

export type SaasCommercialSummary = {
  mrrByCurrency: readonly SaasCommercialCurrencyBucket[];
  arrByCurrency: readonly SaasCommercialCurrencyBucket[];
  activeSubscriptions: number;
  pastDueSubscriptions: number;
  suspendedSubscriptions: number;
  activeCustomers: number;
  trialCustomers: number;
  /**
   * Per-currency outstanding totals across ISSUED / PARTIALLY_PAID /
   * OVERDUE SaaS invoices. Frozen §21.2.
   */
  outstandingInvoices: readonly SaasCommercialOutstandingBucket[];
  collectionStatus: SaasCommercialCollectionBucket;
  /**
   * Customers with any limit usage ≥ 90% (frozen §21.2). List of
   * customer ids — concrete counts require per-customer projection
   * evaluation.
   */
  usageNearingLimitCustomerIds: readonly string[];
  healthCounts: SaasCommercialHealthCounts;
  buildingsUnderSubscription: readonly SaasCommercialBuildingsEntry[];
  computedAt: string;
};
