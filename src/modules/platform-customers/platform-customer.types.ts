/**
 * CR-BE-SAAS-01 PART 01 — SaaS Customer domain types (SaaS Control Plane).
 *
 * The SaaS Customer IS the existing `clients` row (frozen contract §2/§7) —
 * this module extends its registry fields and lifecycle; it never creates a
 * second customer/tenant identity.
 *
 * Legacy compatibility: existing `ACTIVE` / `INACTIVE` rows remain valid
 * values. `INACTIVE` is treated as TERMINATED-equivalent (frozen §7.2) and is
 * never newly written; `ACTIVE` legacy rows keep their legacy meaning and are
 * readable.
 */

/** Frozen SaaS customer lifecycle (contract §7.2). No other states exist. */
export const SAAS_CUSTOMER_STATUSES = [
  'PROSPECT',
  'TRIAL',
  'ACTIVE',
  'GRACE',
  'SUSPENDED',
  'TERMINATED',
] as const;

export type SaaSCustomerStatus = (typeof SAAS_CUSTOMER_STATUSES)[number];

/**
 * Every status value the `clients.status` column may hold: the frozen SaaS
 * lifecycle plus the two legacy values kept for compatibility.
 */
export const SAAS_CUSTOMER_STORAGE_STATUSES = [
  ...SAAS_CUSTOMER_STATUSES,
  'INACTIVE',
] as const;

export type SaaSCustomerStorageStatus =
  (typeof SAAS_CUSTOMER_STORAGE_STATUSES)[number];

export function isSaaSCustomerStatus(value: unknown): value is SaaSCustomerStatus {
  return (
    typeof value === 'string' &&
    (SAAS_CUSTOMER_STATUSES as readonly string[]).includes(value)
  );
}

export function isSaaSCustomerStorageStatus(
  value: unknown,
): value is SaaSCustomerStorageStatus {
  return (
    typeof value === 'string' &&
    (SAAS_CUSTOMER_STORAGE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Frozen customer lifecycle transition table (contract §7.2).
 *
 *   PROSPECT → TRIAL → ACTIVE ⇄ GRACE → SUSPENDED → ACTIVE (reactivation)
 *   any non-terminal status → TERMINATED
 *
 * INACTIVE (legacy) is terminal-equivalent: it has no outgoing transitions.
 * This table is the ONLY place transitions are decided; the HTTP surface
 * never exposes a generic status setter (subscription-driven automation
 * arrives in PART 03+ through the same domain service).
 */
export const SAAS_CUSTOMER_TRANSITIONS: Readonly<
  Record<SaaSCustomerStorageStatus, readonly SaaSCustomerStatus[]>
> = {
  PROSPECT: ['TRIAL', 'TERMINATED'],
  TRIAL: ['ACTIVE', 'SUSPENDED', 'TERMINATED'],
  ACTIVE: ['GRACE', 'SUSPENDED', 'TERMINATED'],
  GRACE: ['ACTIVE', 'SUSPENDED', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'TERMINATED'],
  TERMINATED: [],
  INACTIVE: [],
};

export function allowedCustomerTransitions(
  from: SaaSCustomerStorageStatus,
): readonly SaaSCustomerStatus[] {
  return SAAS_CUSTOMER_TRANSITIONS[from] ?? [];
}

/** Persisted SaaS Customer row (extends the legacy client row). */
export type SaaSCustomerRecord = {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  displayName: string | null;
  taxId: string | null;
  description: string | null;
  status: SaaSCustomerStorageStatus;
  billingEmail: string | null;
  billingPhone: string | null;
  address: string | null;
  country: string | null;
  currencyCode: string | null;
  timezone: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Minimal existing-subscription projection embedded in a customer read. */
export type SaaSCustomerSubscriptionSummary = {
  id: string;
  code: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
};

/** Safe public representation exposed through `/platform/customers`. */
export type PublicSaaSCustomer = {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  displayName: string | null;
  taxId: string | null;
  description: string | null;
  status: SaaSCustomerStorageStatus;
  billingEmail: string | null;
  billingPhone: string | null;
  address: string | null;
  country: string | null;
  currencyCode: string | null;
  timezone: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** Detail read adds the customer's existing subscriptions (PART 01 scope). */
export type PublicSaaSCustomerDetail = PublicSaaSCustomer & {
  subscriptions: SaaSCustomerSubscriptionSummary[];
};

/**
 * Create input. `status` is deliberately absent: creation always starts at
 * PROSPECT (frozen §7.2) and later states are driven by the subscription
 * lifecycle, never by the console create call.
 */
export type CreateSaaSCustomerInput = {
  code: string;
  name: string;
  legalName?: string;
  displayName?: string;
  taxId?: string;
  description?: string;
  billingEmail?: string;
  billingPhone?: string;
  address?: string;
  country?: string;
  currencyCode?: string;
  timezone?: string;
};

/**
 * Update input — registry fields only. `status` and `code` are NOT accepted
 * (lifecycle is subscription-driven; the code is the immutable identity).
 * `expectedVersion` is mandatory (optimistic concurrency, frozen §17.3).
 */
export type UpdateSaaSCustomerInput = {
  expectedVersion: number;
  name?: string;
  legalName?: string;
  displayName?: string;
  taxId?: string;
  description?: string;
  billingEmail?: string;
  billingPhone?: string;
  address?: string;
  country?: string;
  currencyCode?: string;
  timezone?: string;
};

/** List filters (contract §22: `status`, `q`). */
export type ListSaaSCustomerFilters = {
  status?: SaaSCustomerStorageStatus;
  q?: string;
};
