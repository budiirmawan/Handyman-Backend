/**
 * CR-BE-ESG-01 PART 01 — ESG Metric Definition domain types.
 *
 * Governed reference master for ESG metrics (0326). Client-scoped,
 * code-unique, category-classified, ACTIVE/INACTIVE lifecycle.
 *
 * This module owns the metric definition identity only. It does NOT own
 * metric values (PART 03), waste records (PART 02), baselines/targets
 * (PART 04), evidence bindings, aggregation, reporting, emission factors,
 * or any utility duplication (governance §5 / §13).
 */

export const ESG_METRIC_CATEGORIES = [
  'ENERGY',
  'WATER',
  'WASTE',
  'EMISSIONS',
  'OTHER',
] as const;
export type EsgMetricCategory = (typeof ESG_METRIC_CATEGORIES)[number];

export function isEsgMetricCategory(value: unknown): value is EsgMetricCategory {
  return (
    typeof value === 'string' &&
    (ESG_METRIC_CATEGORIES as readonly string[]).includes(value)
  );
}

export const ESG_CALCULATION_METHODS = [
  'CALCULATED',
  'MANUAL',
  'HYBRID',
] as const;
export type EsgCalculationMethod = (typeof ESG_CALCULATION_METHODS)[number];

export function isEsgCalculationMethod(
  value: unknown,
): value is EsgCalculationMethod {
  return (
    typeof value === 'string' &&
    (ESG_CALCULATION_METHODS as readonly string[]).includes(value)
  );
}

export const ESG_METRIC_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type EsgMetricStatus = (typeof ESG_METRIC_STATUSES)[number];

export function isEsgMetricStatus(value: unknown): value is EsgMetricStatus {
  return (
    typeof value === 'string' &&
    (ESG_METRIC_STATUSES as readonly string[]).includes(value)
  );
}

export const ESG_METRIC_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
export const ESG_METRIC_CODE_MIN_LENGTH = 2;
export const ESG_METRIC_CODE_MAX_LENGTH = 64;

/** Full database record. */
export type EsgMetricDefinitionRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  category: EsgMetricCategory;
  uomId: string | null;
  calculationMethod: EsgCalculationMethod;
  status: EsgMetricStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicEsgMetricDefinition = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  category: EsgMetricCategory;
  uomId: string | null;
  calculationMethod: EsgCalculationMethod;
  status: EsgMetricStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  /** Optional resolved UOM context when available. */
  uom?: {
    id: string;
    code: string;
    name: string;
    symbol: string;
  } | null;
};

/** Input supplied by the API consumer when creating a definition. */
export type CreateEsgMetricDefinitionInput = {
  clientId: string;
  code: string;
  name: string;
  description?: string;
  category: EsgMetricCategory;
  uomId?: string | null;
  calculationMethod?: EsgCalculationMethod;
};

/** Fully-resolved data ready for persistence. Created ACTIVE. */
export type NewEsgMetricDefinition = {
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  category: EsgMetricCategory;
  uomId: string | null;
  calculationMethod: EsgCalculationMethod;
  createdByUserId: string;
};

/**
 * Partial update input (PATCH). Identity (`code`, `clientId`) immutable;
 * `status` not editable here — deactivation is governed transition.
 * Only `name`, `description`, `category`, `uomId`, `calculationMethod` editable.
 */
export type UpdateEsgMetricDefinitionInput = {
  name?: string;
  description?: string | null;
  category?: EsgMetricCategory;
  uomId?: string | null;
  calculationMethod?: EsgCalculationMethod;
};

/** List filters for GET /esg/metric-definitions */
export type EsgMetricDefinitionFilters = {
  clientId?: string;
  status?: EsgMetricStatus;
  category?: EsgMetricCategory;
  calculationMethod?: EsgCalculationMethod;
  uomId?: string;
  search?: string;
};
