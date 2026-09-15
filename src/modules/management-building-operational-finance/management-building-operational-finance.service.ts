import { buildingAccessDeniedError } from '../context-access';
import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import { operationalFinanceService } from '../operational-finance';
import {
  managementOperationalFinanceService,
  type PublicManagementOperationalBudgetCategories,
  type PublicManagementOperationalBudgetSummary,
} from '../management-operational-finance';
import {
  managementBuildingOperationalFinanceCurrencyConflictError,
} from './management-building-operational-finance.errors';
import type {
  ManagementBuildingOperationalFinanceCategory,
  ManagementBuildingOperationalFinanceData,
  PublicManagementBuildingOperationalFinance,
} from './management-building-operational-finance.types';
import type { OperationalBudgetFilters } from '../operational-finance';

async function getAuthorizedClientId(
  buildingId: string,
  userId: string,
): Promise<string> {
  const resolved = await resolveManagementReadScope({ buildingId }, userId);
  const client = resolved.context.scope.clients.find((entry) =>
    entry.properties.some((property) =>
      property.buildings.some((building) => building.id === buildingId),
    ),
  );
  if (!client) {
    // The scope resolver already denies this in normal operation. This guard
    // keeps the response shape safe if the hierarchy is unexpectedly stale.
    throw buildingAccessDeniedError();
  }
  return client.id;
}

function utilization(actualAmount: number, plannedAmount: number): number | null {
  return plannedAmount === 0 ? null : (actualAmount / plannedAmount) * 100;
}

function mapCategory(
  category: PublicManagementOperationalBudgetCategories['data']['categories'][number],
): ManagementBuildingOperationalFinanceCategory {
  return {
    categoryId: category.categoryId,
    categoryCode: category.categoryCode,
    categoryName: category.categoryName,
    plannedAmount: category.plannedAmount,
    actualAmount: category.actualAmount,
    committedAmount: category.committedAmount,
    remainingAmount: category.remainingAmount,
    varianceAmount: category.varianceAmount,
    budgetUtilizationPercent: utilization(
      category.actualAmount,
      category.plannedAmount,
    ),
  };
}

function aggregateBudgetSummaries(
  summaries: Array<{
    summary: PublicManagementOperationalBudgetSummary['data'];
    categories: PublicManagementOperationalBudgetCategories['data'];
  }>,
  clientId: string,
  buildingId: string,
  periodStart: string,
  periodEnd: string,
): ManagementBuildingOperationalFinanceData {
  const currencies = [
    ...new Set(
      summaries
        .map(({ summary }) => summary.currency)
        .filter((currency): currency is string => Boolean(currency)),
    ),
  ];
  if (currencies.length > 1) {
    throw managementBuildingOperationalFinanceCurrencyConflictError();
  }

  const categories = summaries.flatMap(({ categories: categoryData }) =>
    categoryData.categories.map(mapCategory),
  );
  const totals = summaries.reduce(
    (total, { summary }) => ({
      plannedAmount: total.plannedAmount + summary.totals.plannedAmount,
      actualAmount: total.actualAmount + summary.totals.actualAmount,
      committedAmount: total.committedAmount + summary.totals.committedAmount,
    }),
    { plannedAmount: 0, actualAmount: 0, committedAmount: 0 },
  );
  const exclusions = summaries.flatMap(({ summary }) => summary.controls);
  const exclusionReasons = [
    ...new Set(exclusions.flatMap((control) => control.exclusionReasons)),
  ].sort();

  return {
    clientId,
    buildingId,
    periodStart,
    periodEnd,
    currency: currencies[0] ?? null,
    plannedAmount: totals.plannedAmount,
    actualAmount: totals.actualAmount,
    committedAmount: totals.committedAmount,
    remainingAmount:
      totals.plannedAmount - totals.actualAmount - totals.committedAmount,
    varianceAmount: totals.plannedAmount - totals.actualAmount,
    activeBudgetCount: summaries.filter(
      ({ summary }) => summary.status === 'ACTIVE',
    ).length,
    categoryCount: categories.length,
    categoriesOverBudget: categories.filter(
      (category) => category.remainingAmount < 0,
    ).length,
    categoriesWithCommitment: categories.filter(
      (category) => category.committedAmount > 0,
    ).length,
    failClosed: exclusions.some((control) => control.failClosed),
    excludedContributionCount: exclusions.reduce(
      (count, control) => count + control.excludedContributionCount,
      0,
    ),
    exclusionReasons,
    categories,
  };
}

export async function getManagementBuildingOperationalFinanceSummary(
  buildingId: string,
  periodStart: string,
  periodEnd: string,
  userId: string,
): Promise<PublicManagementBuildingOperationalFinance> {
  const clientId = await getAuthorizedClientId(buildingId, userId);
  const filters: OperationalBudgetFilters = {
    buildingId,
    periodFrom: periodStart,
    periodTo: periodEnd,
  };
  const budgets = await operationalFinanceService.listOperationalBudgets(
    filters,
    userId,
  );
  const applicableBudgets = budgets.filter((budget) => budget.status !== 'CANCELLED');
  const summaries = await Promise.all(
    applicableBudgets.map(async (budget) => {
      const [summary, categories] = await Promise.all([
        managementOperationalFinanceService.getManagementOperationalBudgetSummary(
          budget.id,
          userId,
        ),
        managementOperationalFinanceService.getManagementOperationalBudgetCategories(
          budget.id,
          userId,
        ),
      ]);
      return {
        summary: summary.data,
        categories: categories.data,
      };
    }),
  );

  const scope = await resolveManagementReadScope(
    { buildingId, dateFrom: periodStart, dateTo: periodEnd },
    userId,
  );
  const data = aggregateBudgetSummaries(
    summaries,
    clientId,
    buildingId,
    periodStart,
    periodEnd,
  );
  return createManagementReadModelContract(
    scope.context,
    { buildingId, periodStart, periodEnd },
    data,
  );
}

export const managementBuildingOperationalFinanceService = {
  getManagementBuildingOperationalFinanceSummary,
};
