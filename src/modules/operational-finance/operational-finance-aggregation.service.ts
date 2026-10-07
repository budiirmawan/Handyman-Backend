import { contextAccessService } from '../context-access';
import { operationalFinanceRepository } from './operational-finance.repository';
import { operationalFinanceAggregationRepository } from './operational-finance-aggregation.repository';
import type {
  OperationalBudgetAggregationExclusion,
  OperationalBudgetAggregationRow,
  PublicOperationalBudgetAggregation,
} from './operational-finance-aggregation.types';
import type {
  OperationalBudgetCategoryRecord,
  OperationalBudgetRecord,
  OperationalFinanceSourceType,
} from './operational-finance.types';
import { operationalBudgetNotFoundError } from './operational-finance.errors';

const ACTUAL_SOURCE_TYPES = new Set<OperationalFinanceSourceType>([
  'BASIC_EXPENSE',
  'VENDOR_SERVICE_COST',
  'VENDOR_INVOICE',
  'WORK_ORDER_MATERIAL',
]);

const COMMITTED_SOURCE_TYPES = new Set<OperationalFinanceSourceType>([
  'PURCHASE_ORDER',
  'PO_LINE',
]);

type ExclusionReason = OperationalBudgetAggregationExclusion['reason'];

type Candidate = {
  row: Awaited<ReturnType<typeof operationalFinanceAggregationRepository.listAggregationSources>>[number];
  kind: 'ACTUAL' | 'COMMITTED';
  amount: number | null;
  baseEligible: boolean;
  currencyEligible: boolean;
  exclusionReason: ExclusionReason | null;
};

const EXCLUSION_PRIORITY: Record<ExclusionReason, number> = {
  SOURCE_NOT_ELIGIBLE: 10,
  SOURCE_AMOUNT_UNAVAILABLE: 20,
  SOURCE_PERIOD_OUTSIDE_BUDGET: 30,
  SOURCE_CURRENCY_UNPROVEN: 40,
  SOURCE_CURRENCY_MISMATCH: 50,
  PO_HEADER_SUPERSEDED_BY_PO_LINE: 60,
  PO_COMMITMENT_REPLACED_BY_ACTUAL: 70,
  SOURCE_REPRESENTED_BY_DOWNSTREAM_ACTUAL: 80,
  SOURCE_LINEAGE_AMBIGUOUS: 90,
};

function exclude(candidate: Candidate, reason: ExclusionReason): void {
  if (
    candidate.exclusionReason === null ||
    EXCLUSION_PRIORITY[reason] > EXCLUSION_PRIORITY[candidate.exclusionReason]
  ) {
    candidate.exclusionReason = reason;
  }
}

function sourceStateEligible(
  row: Candidate['row'],
): boolean {
  switch (row.sourceType) {
    case 'BASIC_EXPENSE':
    case 'VENDOR_SERVICE_COST':
      return row.sourceStatus === 'FINALIZED';
    case 'VENDOR_INVOICE':
      return row.sourceStatus === 'FINALIZED' && row.sourceVerificationStatus === 'VERIFIED';
    case 'PURCHASE_ORDER':
    case 'PO_LINE':
      return row.sourceStatus === 'ISSUED';
    case 'WORK_ORDER_MATERIAL':
      return row.sourceAmount !== null;
  }
}

function sourceAmount(row: Candidate['row']): number | null {
  if (row.sourceAmount === null) return null;
  const amount = Number(row.sourceAmount);
  return Number.isFinite(amount) ? amount : null;
}

function isInsideBudgetPeriod(
  date: string | null,
  budget: OperationalBudgetRecord,
): boolean {
  return date !== null &&
    date >= budget.budgetPeriod.start &&
    date <= budget.budgetPeriod.end;
}

function makeCandidate(
  row: Candidate['row'],
  budget: OperationalBudgetRecord,
): Candidate {
  const kind = ACTUAL_SOURCE_TYPES.has(row.sourceType) ? 'ACTUAL' : 'COMMITTED';
  const candidate: Candidate = {
    row,
    kind,
    amount: sourceAmount(row),
    baseEligible: true,
    currencyEligible: true,
    exclusionReason: null,
  };

  if (!sourceStateEligible(row)) {
    candidate.baseEligible = false;
    exclude(candidate, 'SOURCE_NOT_ELIGIBLE');
    return candidate;
  }
  if (candidate.amount === null) {
    candidate.baseEligible = false;
    exclude(candidate, row.sourceType === 'PURCHASE_ORDER'
      ? 'SOURCE_LINEAGE_AMBIGUOUS'
      : 'SOURCE_AMOUNT_UNAVAILABLE');
    return candidate;
  }
  if (!isInsideBudgetPeriod(row.sourceDate, budget)) {
    candidate.baseEligible = false;
    exclude(candidate, 'SOURCE_PERIOD_OUTSIDE_BUDGET');
    return candidate;
  }

  // MATCHED is a validation result from PART 03, not an amount snapshot. The
  // live source currency is checked again so a changed/malformed source can
  // never silently enter a budget.
  if (
    row.bindingCurrencyStatus !== 'MATCHED' ||
    row.sourceCurrency === null
  ) {
    candidate.currencyEligible = false;
    exclude(candidate, 'SOURCE_CURRENCY_UNPROVEN');
  } else if (row.sourceCurrency !== budget.currency) {
    candidate.currencyEligible = false;
    exclude(candidate, 'SOURCE_CURRENCY_MISMATCH');
  }

  return candidate;
}

function actualLineageKey(row: Candidate['row']): string[] {
  const keys: string[] = [];
  if (row.sourceVendorWorkId) keys.push(`VENDOR_WORK:${row.sourceVendorWorkId}`);
  if (row.sourceWorkOrderId) keys.push(`WORK_ORDER:${row.sourceWorkOrderId}`);
  return keys;
}

function suppressDirectCostRepresentation(candidates: Candidate[]): void {
  const byCostId = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (
      candidate.kind !== 'ACTUAL' ||
      !candidate.baseEligible ||
      !candidate.row.sourceCostId ||
      !['BASIC_EXPENSE', 'VENDOR_SERVICE_COST'].includes(candidate.row.sourceType)
    ) continue;
    const group = byCostId.get(candidate.row.sourceCostId) ?? [];
    group.push(candidate);
    byCostId.set(candidate.row.sourceCostId, group);
  }

  for (const group of byCostId.values()) {
    const basics = group.filter((candidate) => candidate.row.sourceType === 'BASIC_EXPENSE');
    const costs = group.filter((candidate) => candidate.row.sourceType === 'VENDOR_SERVICE_COST');
    if (basics.length === 1 && costs.length > 0) {
      for (const cost of costs) {
        exclude(cost, 'SOURCE_REPRESENTED_BY_DOWNSTREAM_ACTUAL');
      }
    } else if (basics.length > 1 || costs.length > 1) {
      for (const candidate of group) {
        exclude(candidate, 'SOURCE_LINEAGE_AMBIGUOUS');
      }
    }
  }
}

function rejectAmbiguousVendorLineage(candidates: Candidate[]): void {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (
      candidate.kind !== 'ACTUAL' ||
      !candidate.baseEligible ||
      candidate.exclusionReason === 'SOURCE_REPRESENTED_BY_DOWNSTREAM_ACTUAL' ||
      !['BASIC_EXPENSE', 'VENDOR_SERVICE_COST', 'VENDOR_INVOICE'].includes(candidate.row.sourceType)
    ) continue;
    for (const key of actualLineageKey(candidate.row)) {
      const group = groups.get(key) ?? [];
      group.push(candidate);
      groups.set(key, group);
    }
  }

  for (const group of groups.values()) {
    const sourceIds = new Set(group.map((candidate) => candidate.row.sourceId));
    if (sourceIds.size > 1) {
      for (const candidate of group) {
        exclude(candidate, 'SOURCE_LINEAGE_AMBIGUOUS');
      }
    }
  }
}

function suppressOrRejectPoCommitments(candidates: Candidate[]): void {
  const commitments = candidates.filter((candidate) =>
    candidate.kind === 'COMMITTED' && candidate.baseEligible,
  );
  const actuals = candidates.filter((candidate) =>
    candidate.kind === 'ACTUAL' &&
    candidate.baseEligible &&
    candidate.exclusionReason !== 'SOURCE_REPRESENTED_BY_DOWNSTREAM_ACTUAL',
  );

  const lineBoundPurchaseOrders = new Set(
    commitments
      .filter((candidate) => candidate.row.sourceType === 'PO_LINE')
      .flatMap((candidate) => candidate.row.purchaseOrderIds),
  );
  for (const candidate of commitments) {
    if (
      candidate.row.sourceType === 'PURCHASE_ORDER' &&
      candidate.row.purchaseOrderIds.some((id) => lineBoundPurchaseOrders.has(id))
    ) {
      exclude(candidate, 'PO_HEADER_SUPERSEDED_BY_PO_LINE');
    }
  }

  const actualsByPurchaseOrder = new Map<string, Candidate[]>();
  for (const actual of actuals) {
    if (actual.row.purchaseOrderIds.length > 1) {
      exclude(actual, 'SOURCE_LINEAGE_AMBIGUOUS');
    }
    for (const purchaseOrderId of actual.row.purchaseOrderIds) {
      const group = actualsByPurchaseOrder.get(purchaseOrderId) ?? [];
      group.push(actual);
      actualsByPurchaseOrder.set(purchaseOrderId, group);
    }
  }

  for (const commitment of commitments) {
    for (const purchaseOrderId of commitment.row.purchaseOrderIds) {
      const actualsForPurchaseOrder = actualsByPurchaseOrder.get(purchaseOrderId) ?? [];
      const uniqueActuals = new Map(
        actualsForPurchaseOrder.map((actual) => [actual.row.sourceId, actual]),
      );
      if (uniqueActuals.size === 1) {
        const actual = [...uniqueActuals.values()][0];
        if (actual.exclusionReason === 'SOURCE_LINEAGE_AMBIGUOUS') {
          exclude(commitment, 'SOURCE_LINEAGE_AMBIGUOUS');
        } else {
          exclude(commitment, 'PO_COMMITMENT_REPLACED_BY_ACTUAL');
        }
      } else if (uniqueActuals.size > 1) {
        exclude(commitment, 'SOURCE_LINEAGE_AMBIGUOUS');
        for (const actual of uniqueActuals.values()) {
          exclude(actual, 'SOURCE_LINEAGE_AMBIGUOUS');
        }
      }
    }
  }
}

function toExclusion(candidate: Candidate): OperationalBudgetAggregationExclusion {
  return {
    bindingId: candidate.row.bindingId,
    budgetCategoryId: candidate.row.budgetCategoryId,
    sourceType: candidate.row.sourceType,
    sourceId: candidate.row.sourceId,
    reason: candidate.exclusionReason!,
  };
}

function categoryRows(
  categories: OperationalBudgetCategoryRecord[],
): Map<string, OperationalBudgetAggregationRow> {
  return new Map(
    categories.map((category) => [
      category.id,
      {
        budgetCategoryId: category.id,
        categoryCode: category.code,
        categoryName: category.name,
        plannedAmount: category.plannedAmount,
        actualAmount: 0,
        committedAmount: 0,
        remainingAmount: category.plannedAmount,
        varianceAmount: category.plannedAmount,
        actualSourceCount: 0,
        committedSourceCount: 0,
      },
    ]),
  );
}

export async function getOperationalBudgetAggregation(
  budgetId: string,
  actorUserId: string,
): Promise<PublicOperationalBudgetAggregation> {
  const budget = await operationalFinanceRepository.findBudgetById(budgetId);
  if (!budget) throw operationalBudgetNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, budget.buildingId);

  const [categories, sourceRows] = await Promise.all([
    operationalFinanceRepository.listCategories(budgetId),
    operationalFinanceAggregationRepository.listAggregationSources(budgetId),
  ]);
  const candidates = sourceRows.map((row) => makeCandidate(row, budget));

  suppressDirectCostRepresentation(candidates);
  rejectAmbiguousVendorLineage(candidates);
  suppressOrRejectPoCommitments(candidates);

  const byCategory = categoryRows(categories);
  const exclusions: OperationalBudgetAggregationExclusion[] = [];
  for (const candidate of candidates) {
    if (candidate.exclusionReason !== null) {
      exclusions.push(toExclusion(candidate));
      continue;
    }
    const category = byCategory.get(candidate.row.budgetCategoryId);
    if (!category || candidate.amount === null || !candidate.currencyEligible) {
      if (!category) {
        exclusions.push({
          bindingId: candidate.row.bindingId,
          budgetCategoryId: candidate.row.budgetCategoryId,
          sourceType: candidate.row.sourceType,
          sourceId: candidate.row.sourceId,
          reason: 'SOURCE_LINEAGE_AMBIGUOUS',
        });
      }
      continue;
    }
    if (candidate.kind === 'ACTUAL') {
      category.actualAmount += candidate.amount;
      category.actualSourceCount += 1;
    } else {
      category.committedAmount += candidate.amount;
      category.committedSourceCount += 1;
    }
  }

  const categoryList = [...byCategory.values()].map((category) => ({
    ...category,
    remainingAmount: category.plannedAmount - category.actualAmount - category.committedAmount,
    varianceAmount: category.plannedAmount - category.actualAmount,
  }));
  const actualAmount = categoryList.reduce(
    (total, category) => total + category.actualAmount,
    0,
  );
  const committedAmount = categoryList.reduce(
    (total, category) => total + category.committedAmount,
    0,
  );
  const totals = {
    // The budget header is the budget-level plan authority. Active budgets
    // require category plans to equal it; draft budgets may retain an
    // explicitly unallocated planned remainder.
    plannedAmount: budget.plannedAmount,
    actualAmount,
    committedAmount,
    remainingAmount: budget.plannedAmount - actualAmount - committedAmount,
    varianceAmount: budget.plannedAmount - actualAmount,
  };

  return {
    budgetId: budget.id,
    clientId: budget.clientId,
    budgetName: budget.budgetName,
    buildingId: budget.buildingId,
    budgetPeriod: budget.budgetPeriod,
    currency: budget.currency,
    status: budget.status,
    totals,
    categories: categoryList,
    controls: {
      failClosed: exclusions.length > 0,
      excludedContributionCount: exclusions.length,
      exclusions,
    },
    asOf: new Date().toISOString(),
  };
}

export const operationalFinanceAggregationService = {
  getOperationalBudgetAggregation,
};
