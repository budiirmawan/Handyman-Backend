/**
 * CR-BE-FIN-01 PART 01 — Operational Budget Foundation.
 *
 * This module owns Building-scoped budget control metadata only. Operational
 * source transactions remain owned by their existing modules; source binding
 * and any amount aggregation belong to later Finance parts.
 */

export const OPERATIONAL_BUDGET_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'CLOSED',
  'CANCELLED',
] as const;

export type OperationalBudgetStatus =
  (typeof OPERATIONAL_BUDGET_STATUSES)[number];

export function isOperationalBudgetStatus(
  value: unknown,
): value is OperationalBudgetStatus {
  return (
    typeof value === 'string' &&
    (OPERATIONAL_BUDGET_STATUSES as readonly string[]).includes(value)
  );
}

/** The explicit currency vocabulary used by existing commercial sources. */
export const OPERATIONAL_BUDGET_CURRENCIES = [
  'IDR',
  'USD',
  'SGD',
  'MYR',
  'AUD',
  'EUR',
  'GBP',
  'JPY',
  'CNY',
] as const;

export type OperationalBudgetCurrency =
  (typeof OPERATIONAL_BUDGET_CURRENCIES)[number];

export function isOperationalBudgetCurrency(
  value: unknown,
): value is OperationalBudgetCurrency {
  return (
    typeof value === 'string' &&
    (OPERATIONAL_BUDGET_CURRENCIES as readonly string[]).includes(value)
  );
}

/**
 * CR-BE-COMM-VAR-01 PART 01 — governed overspend-control vocabulary.
 *
 * `STRICT` prohibits a future commitment from exceeding available budget.
 * `ALLOW_WITH_OVERRIDE` permits it only through the explicit override
 * authority governed by PART 02. PART 01 stores the declaration only; no
 * override transaction, consumption check, or permission exists yet.
 */
export const OPERATIONAL_BUDGET_OVERSPEND_POLICIES = [
  'STRICT',
  'ALLOW_WITH_OVERRIDE',
] as const;

export type OperationalBudgetOverspendPolicy =
  (typeof OPERATIONAL_BUDGET_OVERSPEND_POLICIES)[number];

export const DEFAULT_OPERATIONAL_BUDGET_OVERSPEND_POLICY: OperationalBudgetOverspendPolicy =
  'STRICT';

export function isOperationalBudgetOverspendPolicy(
  value: unknown,
): value is OperationalBudgetOverspendPolicy {
  return (
    typeof value === 'string' &&
    (OPERATIONAL_BUDGET_OVERSPEND_POLICIES as readonly string[]).includes(value)
  );
}

export type OperationalBudgetPeriod = {
  start: string;
  end: string;
};

/** Full database record. */
export type OperationalBudgetRecord = {
  id: string;
  budgetName: string;
  clientId: string;
  buildingId: string;
  budgetPeriod: OperationalBudgetPeriod;
  currency: OperationalBudgetCurrency;
  plannedAmount: number;
  status: OperationalBudgetStatus;
  overspendPolicy: OperationalBudgetOverspendPolicy;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicOperationalBudget = {
  id: string;
  budgetName: string;
  clientId: string;
  buildingId: string;
  budgetPeriod: OperationalBudgetPeriod;
  currency: OperationalBudgetCurrency;
  plannedAmount: number;
  status: OperationalBudgetStatus;
  overspendPolicy: OperationalBudgetOverspendPolicy;
  createdAt: string;
  updatedAt: string;
};

/** Input for creating a budget; ownership is resolved from the Building path. */
export type CreateOperationalBudgetInput = {
  budgetName?: string;
  budgetPeriod: OperationalBudgetPeriod;
  currency: OperationalBudgetCurrency;
  plannedAmount: number;
  overspendPolicy?: OperationalBudgetOverspendPolicy;
};

export type NewOperationalBudget = Omit<
  CreateOperationalBudgetInput,
  'budgetName' | 'overspendPolicy'
> & {
  budgetName: string;
  overspendPolicy: OperationalBudgetOverspendPolicy;
  clientId: string;
  buildingId: string;
};

/** DRAFT-only editable fields. */
export type UpdateOperationalBudgetInput = {
  budgetName?: string;
  budgetPeriod?: OperationalBudgetPeriod;
  currency?: OperationalBudgetCurrency;
  plannedAmount?: number;
  overspendPolicy?: OperationalBudgetOverspendPolicy;
};

export type OperationalBudgetFilters = {
  buildingId?: string;
  status?: OperationalBudgetStatus;
  periodFrom?: string;
  periodTo?: string;
};

export type OperationalBudgetCategoryRecord = {
  id: string;
  budgetId: string;
  code: string;
  name: string;
  plannedAmount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicOperationalBudgetCategory = {
  id: string;
  budgetId: string;
  code: string;
  name: string;
  plannedAmount: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateOperationalBudgetCategoryInput = {
  code: string;
  name: string;
  plannedAmount: number;
};

export type NewOperationalBudgetCategory = CreateOperationalBudgetCategoryInput & {
  budgetId: string;
};

/** Category code is stable once the category exists. */
export type UpdateOperationalBudgetCategoryInput = {
  name?: string;
  plannedAmount?: number;
};

/**
 * Typed authoritative source references supported by PART 03. A Purchase
 * Order header is a valid lineage anchor only when its single committed line
 * is unambiguous; amount aggregation remains out of scope for this PART.
 */
export const OPERATIONAL_FINANCE_SOURCE_TYPES = [
  'BASIC_EXPENSE',
  'VENDOR_SERVICE_COST',
  'VENDOR_INVOICE',
  'PURCHASE_ORDER',
  'PO_LINE',
  'WORK_ORDER_MATERIAL',
] as const;

export type OperationalFinanceSourceType =
  (typeof OPERATIONAL_FINANCE_SOURCE_TYPES)[number];

export function isOperationalFinanceSourceType(
  value: unknown,
): value is OperationalFinanceSourceType {
  return (
    typeof value === 'string' &&
    (OPERATIONAL_FINANCE_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

export const OPERATIONAL_FINANCE_CURRENCY_STATUSES = [
  'MATCHED',
  'MISSING',
] as const;

export type OperationalFinanceCurrencyStatus =
  (typeof OPERATIONAL_FINANCE_CURRENCY_STATUSES)[number];

export const OPERATIONAL_FINANCE_BINDING_STATUSES = [
  'ACTIVE',
  'REMOVED',
] as const;

export type OperationalFinanceBindingStatus =
  (typeof OPERATIONAL_FINANCE_BINDING_STATUSES)[number];

export type OperationalBudgetSourceReferences = {
  basicExpenseId: string | null;
  vendorServiceCostId: string | null;
  vendorInvoiceId: string | null;
  purchaseOrderId: string | null;
  purchaseOrderLineId: string | null;
  workOrderMaterialUsageId: string | null;
};

export type OperationalBudgetSourceBindingRecord =
  OperationalBudgetSourceReferences & {
    id: string;
    budgetId: string;
    budgetCategoryId: string;
    clientId: string;
    buildingId: string;
    sourceType: OperationalFinanceSourceType;
    currencyStatus: OperationalFinanceCurrencyStatus;
    status: OperationalFinanceBindingStatus;
    createdByUserId: string;
    removedByUserId: string | null;
    removedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };

export type PublicOperationalBudgetSourceBinding =
  Omit<
    OperationalBudgetSourceBindingRecord,
    'removedAt' | 'createdAt' | 'updatedAt'
  > & {
    removedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };

/** The budget id is taken from the route; no source amount is accepted. */
export type CreateOperationalBudgetSourceBindingInput =
  OperationalBudgetSourceReferences & {
    budgetCategoryId: string;
    sourceType: OperationalFinanceSourceType;
  };

export type NewOperationalBudgetSourceBinding =
  CreateOperationalBudgetSourceBindingInput & {
    budgetId: string;
    clientId: string;
    buildingId: string;
    currencyStatus: OperationalFinanceCurrencyStatus;
    createdByUserId: string;
  };
