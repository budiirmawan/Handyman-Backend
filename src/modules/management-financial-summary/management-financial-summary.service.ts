import {
  basicFinancialReportingService,
  type FinancialReportFilters,
  type PublicBasicFinancialSummary,
} from '../basic-financial-reporting';
import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import type {
  ManagementBuildingFinancialSummary,
  ManagementClientFinancialSummary,
  ManagementFinancialSummaryBlock,
  ManagementFinancialSummaryQuery,
  PublicManagementFinancialSummary,
} from './management-financial-summary.types';

/**
 * BE-24 PART 06B — composes authoritative BE-19I Building summaries.
 * Monetary rollups are partitioned by Client; no currency conversion, ledger,
 * tax, accounting or payroll logic exists here.
 */
export async function getManagementFinancialSummary(
  query: ManagementFinancialSummaryQuery,
  userId: string,
): Promise<PublicManagementFinancialSummary> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context } = resolved;
  const filters: FinancialReportFilters = {
    ...(query.scope.dateFrom
      ? { periodFrom: toUtcDate(query.scope.dateFrom) }
      : {}),
    ...(query.scope.dateTo ? { periodTo: toUtcDate(query.scope.dateTo) } : {}),
  };
  const clientByBuilding = mapClientsByBuilding(context.scope.clients);

  const sourceSummaries = await Promise.all(
    context.scope.buildingIds.map((buildingId) =>
      basicFinancialReportingService.getBasicFinancialSummary(
        buildingId,
        filters,
        userId,
      ),
    ),
  );
  const buildingSummaries: ManagementBuildingFinancialSummary[] =
    sourceSummaries
      .map((source) => ({
        clientId: clientByBuilding.get(source.buildingId)!,
        buildingId: source.buildingId,
        summary: toSummaryBlock(source),
      }))
      .sort(
        (left, right) =>
          left.clientId.localeCompare(right.clientId) ||
          left.buildingId.localeCompare(right.buildingId),
      );

  const clients = new Map<string, ManagementClientFinancialSummary>();
  for (const building of buildingSummaries) {
    const current = clients.get(building.clientId);
    if (current) {
      current.buildingIds.push(building.buildingId);
      addSummary(current.summary, building.summary);
    } else {
      clients.set(building.clientId, {
        clientId: building.clientId,
        buildingIds: [building.buildingId],
        summary: cloneSummary(building.summary),
      });
    }
  }
  const clientSummaries = [...clients.values()]
    .map((client) => ({
      ...client,
      buildingIds: [...client.buildingIds].sort(),
    }))
    .sort((left, right) => left.clientId.localeCompare(right.clientId));

  return createManagementReadModelContract(context, {}, {
    clientSummaries,
    buildingSummaries,
  });
}

function toSummaryBlock(
  source: PublicBasicFinancialSummary,
): ManagementFinancialSummaryBlock {
  return {
    tenantCharges: { ...source.tenantBilling.tenantCharges },
    utilityBills: { ...source.tenantBilling.utilityBills },
    invoices: { ...source.invoicePayment.invoices },
    payments: { ...source.invoicePayment.payments },
    receipts: {
      issued: { ...source.receipts.issued },
      void: { ...source.receipts.void },
    },
    vendorServiceCosts: {
      finalized: { ...source.vendorServiceCosts.finalized },
      draftCount: source.vendorServiceCosts.draftCount,
      cancelledCount: source.vendorServiceCosts.cancelledCount,
    },
    basicExpenses: {
      finalized: { ...source.basicExpenses.finalized },
      draftCount: source.basicExpenses.draftCount,
      cancelledCount: source.basicExpenses.cancelledCount,
    },
    outstandingBalance: { ...source.outstandingBalance },
    incomeVsOperationalCost: { ...source.incomeVsOperationalCost },
  };
}

/** Pure addition of values already calculated by BE-19I. */
function addSummary(
  target: ManagementFinancialSummaryBlock,
  source: ManagementFinancialSummaryBlock,
): void {
  addCountAmount(target.tenantCharges, source.tenantCharges);
  target.tenantCharges.cancelledCount += source.tenantCharges.cancelledCount;
  addCountAmount(target.utilityBills, source.utilityBills);
  target.utilityBills.cancelledCount += source.utilityBills.cancelledCount;
  addCountAmount(target.invoices, source.invoices);
  target.invoices.draftCount += source.invoices.draftCount;
  target.invoices.cancelledCount += source.invoices.cancelledCount;

  for (const key of [
    'paidAmount',
    'unpaidAmount',
    'overdueAmount',
    'outstandingAmount',
    'unpaidCount',
    'partiallyPaidCount',
    'paidCount',
    'overdueCount',
  ] as const) {
    target.payments[key] += source.payments[key];
  }
  addCountAmount(target.receipts.issued, source.receipts.issued);
  addCountAmount(target.receipts.void, source.receipts.void);
  addCountAmount(
    target.vendorServiceCosts.finalized,
    source.vendorServiceCosts.finalized,
  );
  target.vendorServiceCosts.draftCount += source.vendorServiceCosts.draftCount;
  target.vendorServiceCosts.cancelledCount +=
    source.vendorServiceCosts.cancelledCount;
  addCountAmount(target.basicExpenses.finalized, source.basicExpenses.finalized);
  target.basicExpenses.draftCount += source.basicExpenses.draftCount;
  target.basicExpenses.cancelledCount += source.basicExpenses.cancelledCount;
  target.outstandingBalance.invoiceCount += source.outstandingBalance.invoiceCount;
  target.outstandingBalance.amount += source.outstandingBalance.amount;

  for (const key of [
    'billedIncome',
    'receivedIncome',
    'operationalCost',
    'netBilled',
    'netReceived',
  ] as const) {
    target.incomeVsOperationalCost[key] += source.incomeVsOperationalCost[key];
  }
}

function addCountAmount(
  target: { count: number; amount: number },
  source: { count: number; amount: number },
): void {
  target.count += source.count;
  target.amount += source.amount;
}

function cloneSummary(
  summary: ManagementFinancialSummaryBlock,
): ManagementFinancialSummaryBlock {
  return structuredClone(summary);
}

function mapClientsByBuilding(
  clients: PublicManagementFinancialSummary['scope']['clients'],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const client of clients) {
    for (const property of client.properties) {
      for (const building of property.buildings) {
        result.set(building.id, client.id);
      }
    }
  }
  return result;
}

function toUtcDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : new Date(value).toISOString().slice(0, 10);
}

export const managementFinancialSummaryService = {
  getManagementFinancialSummary,
};
