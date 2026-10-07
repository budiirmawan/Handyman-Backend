import type { OperationalBudgetAggregationExclusion } from './operational-finance-aggregation.types';
import type {
  OperationalBudgetCurrency,
  OperationalBudgetOverspendPolicy,
  OperationalBudgetPeriod,
  OperationalBudgetStatus,
} from './operational-finance.types';

/**
 * CR-BE-COMM-VAR-01 PART 05 — variance / traceability read contract.
 *
 * Every amount is a 2-decimal number derived at read time. The contract keeps
 * the ledger and legacy contributions visible SEPARATELY as well as combined,
 * so a reader can always see which authority produced a figure.
 */

export type OperationalBudgetVarianceTotals = {
  plannedAmount: number;
  /** PART 02 ledger. */
  ledgerCommittedAmount: number;
  ledgerOpenAmount: number;
  ledgerActualizedAmount: number;
  ledgerReleasedAmount: number;
  /** Eligible pre-ledger CR-BE-FIN-01 source bindings, mutual exclusion applied. */
  legacyCommittedAmount: number;
  /** Incurred cost with no commitment behind it (BUDGET scope only). */
  uncommittedMaterialActualAmount: number;
  uncommittedInvoiceActualAmount: number;
  unallocatedActualAmount: number;
  /** Active/open commitment = ledger open + eligible legacy commitment. */
  openCommitmentAmount: number;
  actualAmount: number;
  consumedAmount: number;
  availableAmount: number;
  varianceAmount: number;
  utilizationPercent: number | null;
  committedUtilizationPercent: number | null;
};

export type OperationalBudgetVarianceCategory = {
  budgetCategoryId: string;
  categoryCode: string;
  categoryName: string;
  plannedAmount: number;
  ledgerCommittedAmount: number;
  ledgerOpenAmount: number;
  ledgerActualizedAmount: number;
  ledgerReleasedAmount: number;
  legacyCommittedAmount: number;
  openCommitmentAmount: number;
  actualAmount: number;
  consumedAmount: number;
  availableAmount: number;
  varianceAmount: number;
  utilizationPercent: number | null;
  committedUtilizationPercent: number | null;
  commitmentCount: number;
};

/** A recorded gap is described, never valued. */
export type OperationalBudgetVarianceGap = {
  code: 'CURRENCYLESS_COST_AUTHORITY' | 'VENDOR_ACTUAL_WITHOUT_COMMITMENT';
  reference: 'B-02' | 'B-03';
  message: string;
  affectedSourceCount: number;
};

export type PublicOperationalBudgetVariance = {
  budgetId: string;
  clientId: string;
  buildingId: string;
  budgetName: string;
  budgetPeriod: OperationalBudgetPeriod;
  currency: OperationalBudgetCurrency;
  status: OperationalBudgetStatus;
  overspendPolicy: OperationalBudgetOverspendPolicy;
  totals: OperationalBudgetVarianceTotals;
  categories: OperationalBudgetVarianceCategory[];
  controls: {
    categoryScopeIncludesUnallocatedActual: boolean;
    legacyCommitmentSupersededCount: number;
    failClosed: boolean;
    excludedContributionCount: number;
    exclusions: OperationalBudgetAggregationExclusion[];
  };
  gaps: OperationalBudgetVarianceGap[];
  asOf: string;
};

export type PublicOperationalBudgetVarianceSummary = {
  budgetId: string;
  clientId: string;
  buildingId: string;
  budgetName: string;
  budgetPeriod: OperationalBudgetPeriod;
  currency: OperationalBudgetCurrency;
  status: OperationalBudgetStatus;
  totals: OperationalBudgetVarianceTotals;
  failClosed: boolean;
  gapCount: number;
};

export type OperationalBudgetTraceabilityClassification =
  | 'COMMITMENT'
  | 'LEGACY_COMMITMENT'
  | 'ACTUAL'
  | 'EXCLUDED';

export type OperationalBudgetTraceabilityRow = {
  classification: OperationalBudgetTraceabilityClassification;
  sourceType: string;
  sourceId: string;
  commitmentId: string | null;
  bindingId: string | null;
  budgetCategoryId: string | null;
  amount: number | null;
  openAmount: number | null;
  actualizedAmount: number | null;
  currency: string | null;
  status: string | null;
  description: string | null;
  purchaseOrderId: string | null;
  purchaseOrderLineId: string | null;
  vendorId: string | null;
  workOrderId: string | null;
  materialRequestId: string | null;
  vendorInvoiceId: string | null;
  workOrderMaterialUsageId: string | null;
  exclusionReason: string | null;
};

export type PublicOperationalBudgetTraceability = {
  budgetId: string;
  clientId: string;
  buildingId: string;
  budgetPeriod: OperationalBudgetPeriod;
  currency: OperationalBudgetCurrency;
  rowCount: number;
  rows: OperationalBudgetTraceabilityRow[];
  asOf: string;
};
