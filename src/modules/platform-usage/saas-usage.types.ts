/**
 * CR-BE-SAAS-01 PART 09 — Usage & Metering types (frozen §12.3, §22).
 *
 * Type-only contract surface. No DB or HTTP imports.
 */

/** Frozen §12.3 — usage record/aggregation scope. */
export type SaasUsageScope =
  | 'CURRENT'
  | 'DAILY'
  | 'MONTHLY'
  | 'BILLING_PERIOD';

/** Frozen §12.3 — usage record source authority. */
export type SaasUsageSource = 'BACKEND' | 'TRUSTED_INTEGRATION';

/** Frozen §12.3 — meter period types (subset supported). */
export type SaasUsagePeriodType = 'DAILY' | 'MONTHLY' | 'BILLING_PERIOD';

export type SaasMeterStatus = 'ACTIVE' | 'INACTIVE';

export type SaasMeterRecord = {
  id: string;
  meterKey: string;
  name: string;
  unit: string;
  periodTypes: readonly SaasUsagePeriodType[];
  status: SaasMeterStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type SaasUsageRecordRow = {
  id: string;
  customerId: string;
  buildingId: string | null;
  meterKey: string;
  quantity: string; // NUMERIC string (server canonical)
  scope: SaasUsageScope;
  periodStart: Date;
  periodEnd: Date;
  source: SaasUsageSource;
  sourceReference: string;
  recordedByUserId: string | null;
  createdAt: Date;
};

export type SaasUsageAggregationRow = {
  id: string;
  customerId: string;
  meterKey: string;
  scope: SaasUsageScope;
  periodStart: Date;
  periodEnd: Date;
  totalQuantity: string;
  recordCount: number;
  updatedAt: Date;
  version: number;
};

export type CreateSaasMeterInput = {
  meterKey: string;
  name: string;
  unit: string;
  periodTypes: readonly SaasUsagePeriodType[];
};

export type RecordUsageInput = {
  customerId: string;
  buildingId?: string | null;
  meterKey: string;
  quantity: string; // NUMERIC string, >= 0
  scope: SaasUsageScope;
  periodStart: string; // ISO timestamp
  periodEnd: string;
  source: SaasUsageSource;
  sourceReference: string;
  recordedByUserId?: string | null;
};

/**
 * Quota projection (frozen §12.3 last bullet + §22 routes):
 * GET /platform/customers/:id/usage and /me/usage return per-meter
 * { limit, used, available, periodStart, periodEnd }.
 *
 * `available` semantics:
 *   limit == 0 (frozen "0 = unlimited") → available = null (unbounded).
 *   limit == null (no applicable package limit) → available = null
 *     (the entitlement is not quota-bounded).
 *   otherwise available = max(limit - used, 0).
 *
 * `remaining` is the same number; both fields are present so consumers
 * don't need to compute.
 */
export type CustomerUsageProjectionMeter = {
  meterKey: string;
  unit: string;
  scope: SaasUsageScope;
  periodStart: string;
  periodEnd: string;
  limit: number | null;
  used: number | string; // numeric string from DB, or 0 when no aggregation
  available: number | null;
};

export type CustomerUsageProjection = {
  customerId: string;
  meters: readonly CustomerUsageProjectionMeter[];
  computedAt: string;
};

/** Filter for listing usage records (frozen §22). */
export type ListUsageRecordsParams = {
  customerId?: string;
  meterKey?: string;
  scope?: SaasUsageScope;
  periodStart?: string;
  periodEnd?: string;
};
