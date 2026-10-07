import { contextAccessService } from '../context-access';
import { operationalFinanceAggregationService } from './operational-finance-aggregation.service';
import type { OperationalBudgetAggregationExclusion } from './operational-finance-aggregation.types';
import { operationalBudgetNotFoundError } from './operational-finance.errors';
import { operationalFinanceRepository } from './operational-finance.repository';
import type { OperationalBudgetFilters } from './operational-finance.types';
import { operationalVarianceRepository } from './operational-variance.repository';
import type {
  OperationalBudgetVarianceCategory,
  OperationalBudgetVarianceGap,
  PublicOperationalBudgetTraceability,
  PublicOperationalBudgetVariance,
  PublicOperationalBudgetVarianceSummary,
} from './operational-variance.types';

/**
 * CR-BE-COMM-VAR-01 PART 05 — Variance + traceability read model.
 *
 * Fully derived at read time. It introduces no financial authority, no stored
 * balance and no scheduler: every figure is recomputed from the PART 02 ledger,
 * the CR-BE-FIN-01 typed bindings, and the authoritative cost transactions.
 *
 * Governing formulas (all amounts in the budget currency, 2 decimals):
 *
 *   openCommitment  = ledgerOpen + eligibleLegacyCommitment
 *   consumed        = (ledgerCommitted - ledgerReleased)
 *                     + eligibleLegacyCommitment
 *                     + unallocatedActual
 *   actual          = ledgerActualized + unallocatedActual
 *   available       = planned - consumed
 *   variance        = planned - actual          (positive = under budget)
 *   utilization%    = actual / planned * 100                    (null if 0)
 *   committedUtil%  = (actual + openCommitment) / planned * 100 (null if 0)
 *
 * `unallocatedActual` is incurred cost with no commitment behind it: costed
 * Work Order material usages and verified vendor invoices in the budget's
 * Building, period and currency, each net of the portion already actualized
 * against a commitment. It is a BUDGET-scope figure only, because an unmatched
 * source carries no cost category and inventing one would violate the governed
 * explicit-category rule.
 */

/** Currency-less operational cost authorities (blocker B-02). */
const CURRENCYLESS_ACTUAL_SOURCE_TYPES = ['VENDOR_SERVICE_COST', 'BASIC_EXPENSE'];

function money(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function percent(numerator: number, planned: number): number | null {
  return planned === 0 ? null : round2((numerator / planned) * 100);
}

export async function getOperationalBudgetVariance(
  budgetId: string,
  actorUserId: string,
): Promise<PublicOperationalBudgetVariance> {
  const budget = await operationalFinanceRepository.findBudgetById(budgetId);
  if (!budget) throw operationalBudgetNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, budget.buildingId);

  const [categories, ledgerRows, legacyRows, materialRows, invoiceRows, legacy] =
    await Promise.all([
      operationalFinanceRepository.listCategories(budgetId),
      operationalVarianceRepository.ledgerByCategory(budgetId),
      operationalVarianceRepository.legacyCommitments(budgetId),
      operationalVarianceRepository.materialActuals(budgetId),
      operationalVarianceRepository.invoiceActuals(budgetId),
      // The existing CR-BE-FIN-01 aggregation stays the authority for the
      // fail-closed source-eligibility contract; its exclusion reasons are
      // surfaced here rather than re-derived.
      operationalFinanceAggregationService.getOperationalBudgetAggregation(
        budgetId,
        actorUserId,
      ),
    ]);

  const ledgerByCategory = new Map(
    ledgerRows.map((row) => [row.budgetCategoryId, row]),
  );

  const exclusions: OperationalBudgetAggregationExclusion[] = [
    ...legacy.controls.exclusions,
  ];

  // Legacy commitment contributions, with mutual exclusion applied.
  const legacyCommittedByCategory = new Map<string, number>();
  let legacySupersededCount = 0;
  for (const row of legacyRows) {
    if (row.supersededByLedger) {
      // The same Purchase Order is represented by a ledger commitment: the
      // binding must not contribute, or the obligation counts twice.
      legacySupersededCount += 1;
      exclusions.push({
        bindingId: row.bindingId,
        budgetCategoryId: row.budgetCategoryId,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        reason: 'SOURCE_REPRESENTED_BY_DOWNSTREAM_ACTUAL',
      });
      continue;
    }
    if (row.sourceStatus !== 'ISSUED') {
      exclusions.push({
        bindingId: row.bindingId,
        budgetCategoryId: row.budgetCategoryId,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        reason: 'SOURCE_NOT_ELIGIBLE',
      });
      continue;
    }
    if (row.amount === null) {
      exclusions.push({
        bindingId: row.bindingId,
        budgetCategoryId: row.budgetCategoryId,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        reason: 'SOURCE_LINEAGE_AMBIGUOUS',
      });
      continue;
    }
    if (row.currency !== budget.currency) {
      exclusions.push({
        bindingId: row.bindingId,
        budgetCategoryId: row.budgetCategoryId,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        reason: 'SOURCE_CURRENCY_MISMATCH',
      });
      continue;
    }
    legacyCommittedByCategory.set(
      row.budgetCategoryId,
      round2(
        (legacyCommittedByCategory.get(row.budgetCategoryId) ?? 0) +
          money(row.amount),
      ),
    );
  }

  const categoryRows: OperationalBudgetVarianceCategory[] = categories.map(
    (category) => {
      const ledger = ledgerByCategory.get(category.id);
      const ledgerCommitted = money(ledger?.committedAmount);
      const ledgerOpen = money(ledger?.openAmount);
      const ledgerActualized = money(ledger?.actualizedAmount);
      const ledgerReleased = money(ledger?.releasedAmount);
      const legacyCommitted = legacyCommittedByCategory.get(category.id) ?? 0;

      const openCommitment = round2(ledgerOpen + legacyCommitted);
      const consumed = round2(
        ledgerCommitted - ledgerReleased + legacyCommitted,
      );

      return {
        budgetCategoryId: category.id,
        categoryCode: category.code,
        categoryName: category.name,
        plannedAmount: category.plannedAmount,
        ledgerCommittedAmount: round2(ledgerCommitted),
        ledgerOpenAmount: round2(ledgerOpen),
        ledgerActualizedAmount: round2(ledgerActualized),
        ledgerReleasedAmount: round2(ledgerReleased),
        legacyCommittedAmount: legacyCommitted,
        openCommitmentAmount: openCommitment,
        actualAmount: round2(ledgerActualized),
        consumedAmount: consumed,
        availableAmount: round2(category.plannedAmount - consumed),
        varianceAmount: round2(category.plannedAmount - ledgerActualized),
        utilizationPercent: percent(ledgerActualized, category.plannedAmount),
        committedUtilizationPercent: percent(
          ledgerActualized + openCommitment,
          category.plannedAmount,
        ),
        commitmentCount: ledger?.commitmentCount ?? 0,
      };
    },
  );

  const uncommittedMaterialActual = round2(
    materialRows.reduce((total, row) => total + money(row.uncommittedAmount), 0),
  );
  const uncommittedInvoiceActual = round2(
    invoiceRows.reduce((total, row) => total + money(row.uncommittedAmount), 0),
  );
  const unallocatedActual = round2(
    uncommittedMaterialActual + uncommittedInvoiceActual,
  );

  const ledgerCommittedTotal = round2(
    categoryRows.reduce((total, row) => total + row.ledgerCommittedAmount, 0),
  );
  const ledgerOpenTotal = round2(
    categoryRows.reduce((total, row) => total + row.ledgerOpenAmount, 0),
  );
  const ledgerActualizedTotal = round2(
    categoryRows.reduce((total, row) => total + row.ledgerActualizedAmount, 0),
  );
  const ledgerReleasedTotal = round2(
    categoryRows.reduce((total, row) => total + row.ledgerReleasedAmount, 0),
  );
  const legacyCommittedTotal = round2(
    categoryRows.reduce((total, row) => total + row.legacyCommittedAmount, 0),
  );

  const openCommitmentTotal = round2(ledgerOpenTotal + legacyCommittedTotal);
  const actualTotal = round2(ledgerActualizedTotal + unallocatedActual);
  const consumedTotal = round2(
    ledgerCommittedTotal -
      ledgerReleasedTotal +
      legacyCommittedTotal +
      unallocatedActual,
  );

  // Gaps are reported, never valued. Inventing an amount for a currency-less
  // authority or for vendor work with no priced source is explicitly forbidden.
  // CUR-02 PART 05: the B-02 cost authorities are now data-driven. A source is
  // only surfaced as a currency gap when it is genuinely UNKNOWN (currency
  // unproven) — never blanket-excluded because of its source type. Known-currency
  // rows now flow through exact-currency comparison; rows excluded for any other
  // reason are not mislabelled as currencyless.
  const gaps: OperationalBudgetVarianceGap[] = [];
  const currencylessBindings = legacy.controls.exclusions.filter(
    (exclusion) =>
      exclusion.reason === 'SOURCE_CURRENCY_UNPROVEN' &&
      CURRENCYLESS_ACTUAL_SOURCE_TYPES.includes(exclusion.sourceType),
  );
  if (currencylessBindings.length > 0) {
    gaps.push({
      code: 'CURRENCYLESS_COST_AUTHORITY',
      reference: 'B-02',
      message:
        'vendor_service_costs and basic_expenses with an unknown currency are excluded from currency-dependent figures.',
      affectedSourceCount: currencylessBindings.length,
    });
  }
  const vendorWithoutCommitment = invoiceRows.filter(
    (row) => row.commitmentId === null,
  );
  if (vendorWithoutCommitment.length > 0) {
    gaps.push({
      code: 'VENDOR_ACTUAL_WITHOUT_COMMITMENT',
      reference: 'B-03',
      message:
        'No approved vendor amount exists before a Purchase Order, so these verified invoices are actual cost with no preceding commitment.',
      affectedSourceCount: vendorWithoutCommitment.length,
    });
  }

  return {
    budgetId: budget.id,
    clientId: budget.clientId,
    buildingId: budget.buildingId,
    budgetName: budget.budgetName,
    budgetPeriod: budget.budgetPeriod,
    currency: budget.currency,
    status: budget.status,
    overspendPolicy: budget.overspendPolicy,
    totals: {
      plannedAmount: round2(budget.plannedAmount),
      ledgerCommittedAmount: ledgerCommittedTotal,
      ledgerOpenAmount: ledgerOpenTotal,
      ledgerActualizedAmount: ledgerActualizedTotal,
      ledgerReleasedAmount: ledgerReleasedTotal,
      legacyCommittedAmount: legacyCommittedTotal,
      uncommittedMaterialActualAmount: uncommittedMaterialActual,
      uncommittedInvoiceActualAmount: uncommittedInvoiceActual,
      unallocatedActualAmount: unallocatedActual,
      openCommitmentAmount: openCommitmentTotal,
      actualAmount: actualTotal,
      consumedAmount: consumedTotal,
      availableAmount: round2(budget.plannedAmount - consumedTotal),
      varianceAmount: round2(budget.plannedAmount - actualTotal),
      utilizationPercent: percent(actualTotal, budget.plannedAmount),
      committedUtilizationPercent: percent(
        actualTotal + openCommitmentTotal,
        budget.plannedAmount,
      ),
    },
    categories: categoryRows,
    controls: {
      // Category figures deliberately exclude unallocated actual: an unmatched
      // source has no cost category and none is inferred.
      categoryScopeIncludesUnallocatedActual: false,
      legacyCommitmentSupersededCount: legacySupersededCount,
      failClosed: exclusions.length > 0,
      excludedContributionCount: exclusions.length,
      exclusions,
    },
    gaps,
    asOf: new Date().toISOString(),
  };
}

/**
 * Portfolio breakdown by Building and period: one variance summary per
 * accessible budget. Building and period are the budget's own dimensions, so
 * no new aggregation axis is introduced.
 */
export async function listOperationalBudgetVariance(
  filters: OperationalBudgetFilters,
  actorUserId: string,
): Promise<PublicOperationalBudgetVarianceSummary[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  }
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(
    actorUserId,
  );
  const budgets = await operationalFinanceRepository.listBudgets(
    filters,
    buildingIds,
  );

  const summaries: PublicOperationalBudgetVarianceSummary[] = [];
  for (const budget of budgets) {
    const variance = await getOperationalBudgetVariance(budget.id, actorUserId);
    summaries.push({
      budgetId: variance.budgetId,
      clientId: variance.clientId,
      buildingId: variance.buildingId,
      budgetName: variance.budgetName,
      budgetPeriod: variance.budgetPeriod,
      currency: variance.currency,
      status: variance.status,
      totals: variance.totals,
      failClosed: variance.controls.failClosed,
      gapCount: variance.gaps.length,
    });
  }
  return summaries;
}

/**
 * Flat source-transaction traceability: every commitment, every costed
 * material issue and every verified invoice that contributes to (or is
 * excluded from) the budget, with its classification and lineage keys.
 */
export async function getOperationalBudgetTraceability(
  budgetId: string,
  actorUserId: string,
): Promise<PublicOperationalBudgetTraceability> {
  const budget = await operationalFinanceRepository.findBudgetById(budgetId);
  if (!budget) throw operationalBudgetNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, budget.buildingId);

  const [commitments, legacyRows, materialRows, invoiceRows] = await Promise.all([
    operationalVarianceRepository.commitmentTrace(budgetId),
    operationalVarianceRepository.legacyCommitments(budgetId),
    operationalVarianceRepository.materialActuals(budgetId),
    operationalVarianceRepository.invoiceActuals(budgetId),
  ]);

  const rows: PublicOperationalBudgetTraceability['rows'] = [];

  for (const commitment of commitments) {
    rows.push({
      classification:
        commitment.status === 'CANCELLED' ? 'EXCLUDED' : 'COMMITMENT',
      sourceType: commitment.origin === 'MANUAL' ? 'MANUAL_COMMITMENT' : 'PO_LINE',
      sourceId: commitment.purchaseOrderLineId ?? commitment.commitmentId,
      commitmentId: commitment.commitmentId,
      bindingId: null,
      budgetCategoryId: commitment.budgetCategoryId,
      amount: Number(commitment.committedAmount),
      openAmount: Number(commitment.openAmount),
      actualizedAmount: Number(commitment.actualizedAmount),
      currency: commitment.currency,
      status: commitment.status,
      description: commitment.title,
      purchaseOrderId: commitment.purchaseOrderId,
      purchaseOrderLineId: commitment.purchaseOrderLineId,
      vendorId: commitment.vendorId,
      workOrderId: commitment.workOrderId,
      materialRequestId: commitment.materialRequestId,
      vendorInvoiceId: null,
      workOrderMaterialUsageId: null,
      exclusionReason:
        commitment.status === 'CANCELLED' ? 'SOURCE_NOT_ELIGIBLE' : null,
    });
  }

  for (const row of legacyRows) {
    rows.push({
      classification: row.supersededByLedger ? 'EXCLUDED' : 'LEGACY_COMMITMENT',
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      commitmentId: row.ledgerCommitmentId,
      bindingId: row.bindingId,
      budgetCategoryId: row.budgetCategoryId,
      amount: row.amount === null ? null : Number(row.amount),
      openAmount: null,
      actualizedAmount: null,
      currency: row.currency,
      status: row.sourceStatus,
      description: null,
      purchaseOrderId: row.purchaseOrderId,
      purchaseOrderLineId: row.purchaseOrderLineId,
      vendorId: row.vendorId,
      workOrderId: null,
      materialRequestId: row.materialRequestId,
      vendorInvoiceId: null,
      workOrderMaterialUsageId: null,
      exclusionReason: row.supersededByLedger
        ? 'SOURCE_REPRESENTED_BY_DOWNSTREAM_ACTUAL'
        : row.sourceStatus !== 'ISSUED'
          ? 'SOURCE_NOT_ELIGIBLE'
          : row.amount === null
            ? 'SOURCE_LINEAGE_AMBIGUOUS'
            : null,
    });
  }

  for (const row of materialRows) {
    rows.push({
      classification: 'ACTUAL',
      sourceType: 'WORK_ORDER_MATERIAL',
      sourceId: row.usageId,
      commitmentId: row.commitmentId,
      bindingId: row.bindingId,
      budgetCategoryId: null,
      amount: Number(row.totalCost),
      openAmount: null,
      actualizedAmount: Number(row.actualizedAmount),
      currency: row.currency,
      status: 'COSTED',
      description: null,
      purchaseOrderId: null,
      purchaseOrderLineId: null,
      vendorId: null,
      workOrderId: row.workOrderId,
      materialRequestId: row.materialRequestId,
      vendorInvoiceId: null,
      workOrderMaterialUsageId: row.usageId,
      exclusionReason: null,
    });
  }

  for (const row of invoiceRows) {
    rows.push({
      classification: 'ACTUAL',
      sourceType: 'VENDOR_INVOICE',
      sourceId: row.invoiceId,
      commitmentId: row.commitmentId,
      bindingId: row.bindingId,
      budgetCategoryId: null,
      amount: Number(row.invoiceAmount),
      openAmount: null,
      actualizedAmount: Number(row.actualizedAmount),
      currency: row.currency,
      status: 'VERIFIED',
      description: row.invoiceNumber,
      purchaseOrderId: row.purchaseOrderId,
      purchaseOrderLineId: null,
      vendorId: row.vendorId,
      workOrderId: row.workOrderId,
      materialRequestId: null,
      vendorInvoiceId: row.invoiceId,
      workOrderMaterialUsageId: null,
      exclusionReason: null,
    });
  }

  return {
    budgetId: budget.id,
    clientId: budget.clientId,
    buildingId: budget.buildingId,
    budgetPeriod: budget.budgetPeriod,
    currency: budget.currency,
    rowCount: rows.length,
    rows,
    asOf: new Date().toISOString(),
  };
}

export const operationalVarianceService = {
  getOperationalBudgetTraceability,
  getOperationalBudgetVariance,
  listOperationalBudgetVariance,
};
