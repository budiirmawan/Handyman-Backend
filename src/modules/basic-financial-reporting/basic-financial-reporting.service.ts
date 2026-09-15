import { contextAccessService } from '../context-access';
import { basicFinancialReportingRepository as repo } from './basic-financial-reporting.repository';
import type {
  BasicFinancialCurrencySafeFoundation,
  FinancialReportFilters,
  PublicBasicFinancialSummary,
} from './basic-financial-reporting.types';
import { buildMonetarySummary } from './basic-financial-reporting.monetary-summary';

function collectDistinctCurrencies(...grouped: Array<{ byCurrency: Record<string, any> }>): string[] {
  const set = new Set<string>();
  for (const g of grouped) {
    for (const code of Object.keys(g.byCurrency)) set.add(code);
  }
  return Array.from(set).sort();
}

function hasAnyUnknown(...grouped: Array<{ unknown: { count?: number; amount?: number; paidAmount?: number; unpaidAmount?: number; overdueAmount?: number; outstandingAmount?: number } | { amount: number } }>): boolean {
  for (const g of grouped) {
    const u: any = g.unknown;
    if (!u) continue;
    if ((u.count ?? 0) > 0) return true;
    if ((u.amount ?? 0) !== 0) return true;
    if (typeof u.paidAmount === 'number' && u.paidAmount !== 0) return true;
    if (typeof u.unpaidAmount === 'number' && u.unpaidAmount !== 0) return true;
    if (typeof u.overdueAmount === 'number' && u.overdueAmount !== 0) return true;
    if (typeof u.outstandingAmount === 'number' && u.outstandingAmount !== 0) return true;
  }
  return false;
}

function singleCurrencyAmount(byCurrency: Record<string, { amount: number }>, unknown: { amount: number; count?: number } | any): number | null {
  const codes = Object.keys(byCurrency);
  const hasUnknown = (unknown?.count ?? 0) > 0 || (unknown?.amount ?? 0) !== 0 || (unknown?.paidAmount ?? 0) !== 0 || (unknown?.outstandingAmount ?? 0) !== 0;
  if (hasUnknown) return null;
  if (codes.length === 1) return byCurrency[codes[0]].amount;
  if (codes.length === 0) return 0;
  return null;
}

export async function getCurrencySafeFoundation(
  buildingId: string,
  filters: FinancialReportFilters,
  actor: string,
): Promise<BasicFinancialCurrencySafeFoundation> {
  await contextAccessService.assertBuildingAccess(actor, buildingId);
  const scope = { buildingId, filters };

  const [tenantCharges, utilityBills, byTenant, invoices, payments, receipts, vendorCosts, basicExpenses, unrepresented] = await Promise.all([
    repo.tenantChargesGrouped(scope),
    repo.utilityBillsGrouped(scope),
    repo.byTenantGrouped(scope),
    repo.invoicesGrouped(scope),
    repo.paymentsGrouped(scope),
    repo.receiptsGrouped(scope),
    repo.vendorCostsGrouped(scope),
    repo.basicExpensesGrouped(scope),
    repo.unrepresentedVendorCostGrouped(scope),
  ]);

  const distinctKnownCurrencies = collectDistinctCurrencies(
    tenantCharges,
    utilityBills,
    invoices,
    { byCurrency: payments.byCurrency } as any,
    receipts.issued,
    receipts.void,
    vendorCosts,
    basicExpenses,
    unrepresented as any,
  );

  const hasUnknown = hasAnyUnknown(
    tenantCharges,
    utilityBills,
    invoices,
    payments as any,
    receipts.issued,
    receipts.void,
    vendorCosts,
    basicExpenses,
    unrepresented as any,
  );

  return {
    buildingId,
    periodFrom: filters.periodFrom ?? null,
    periodTo: filters.periodTo ?? null,
    tenantCompanyId: filters.tenantCompanyId ?? null,
    tenantBilling: {
      tenantCharges: {
        totalActiveCount: tenantCharges.totalActiveCount,
        cancelledCount: tenantCharges.cancelledCount,
        byCurrency: tenantCharges.byCurrency,
        unknown: tenantCharges.unknown,
      },
      utilityBills: {
        totalNonCancelledCount: utilityBills.totalNonCancelledCount,
        cancelledCount: utilityBills.cancelledCount,
        byCurrency: utilityBills.byCurrency,
        unknown: utilityBills.unknown,
      },
      byTenant,
    },
    invoicePayment: {
      invoices: {
        finalizedCount: invoices.finalizedCount,
        draftCount: invoices.draftCount,
        cancelledCount: invoices.cancelledCount,
        byCurrency: invoices.byCurrency,
        unknown: invoices.unknown,
      },
      payments: {
        byCurrency: payments.byCurrency,
        unknown: payments.unknown,
        totalCounts: payments.totalCounts,
      },
    },
    receipts: {
      issued: {
        totalCount: receipts.issued.totalCount,
        byCurrency: receipts.issued.byCurrency,
        unknown: receipts.issued.unknown,
      },
      void: {
        totalCount: receipts.void.totalCount,
        byCurrency: receipts.void.byCurrency,
        unknown: receipts.void.unknown,
      },
    },
    vendorServiceCosts: {
      finalizedCount: vendorCosts.finalizedCount,
      draftCount: vendorCosts.draftCount,
      cancelledCount: vendorCosts.cancelledCount,
      byCurrency: vendorCosts.byCurrency,
      unknown: vendorCosts.unknown,
    },
    basicExpenses: {
      finalizedCount: basicExpenses.finalizedCount,
      draftCount: basicExpenses.draftCount,
      cancelledCount: basicExpenses.cancelledCount,
      byCurrency: basicExpenses.byCurrency,
      unknown: basicExpenses.unknown,
    },
    unrepresentedVendorCosts: {
      byCurrency: unrepresented.byCurrency,
      unknown: unrepresented.unknown,
    },
    distinctKnownCurrencies,
    hasUnknown,
  };
}

export async function getBasicFinancialSummary(
  buildingId: string,
  filters: FinancialReportFilters,
  actor: string,
): Promise<PublicBasicFinancialSummary> {
  const foundation = await getCurrencySafeFoundation(buildingId, filters, actor);
  const monetarySummary = buildMonetarySummary(foundation);

  const tcAmount = singleCurrencyAmount(foundation.tenantBilling.tenantCharges.byCurrency, foundation.tenantBilling.tenantCharges.unknown);
  const ubAmount = singleCurrencyAmount(foundation.tenantBilling.utilityBills.byCurrency, foundation.tenantBilling.utilityBills.unknown);
  const invAmount = singleCurrencyAmount(foundation.invoicePayment.invoices.byCurrency, foundation.invoicePayment.invoices.unknown);

  const pay = foundation.invoicePayment.payments;
  const payCodes = Object.keys(pay.byCurrency);
  const payHasUnknown =
    pay.unknown.paidAmount !== 0 ||
    pay.unknown.unpaidAmount !== 0 ||
    pay.unknown.overdueAmount !== 0 ||
    pay.unknown.outstandingAmount !== 0 ||
    pay.unknown.unpaidCount > 0;

  const paidAmount = !payHasUnknown && payCodes.length === 1 ? pay.byCurrency[payCodes[0]].paidAmount : payCodes.length === 0 && !payHasUnknown ? 0 : null;
  const unpaidAmount = !payHasUnknown && payCodes.length === 1 ? pay.byCurrency[payCodes[0]].unpaidAmount : payCodes.length === 0 && !payHasUnknown ? 0 : null;
  const overdueAmount = !payHasUnknown && payCodes.length === 1 ? pay.byCurrency[payCodes[0]].overdueAmount : payCodes.length === 0 && !payHasUnknown ? 0 : null;
  const outstandingAmount = !payHasUnknown && payCodes.length === 1 ? pay.byCurrency[payCodes[0]].outstandingAmount : payCodes.length === 0 && !payHasUnknown ? 0 : null;

  const issuedAmount = singleCurrencyAmount(foundation.receipts.issued.byCurrency, foundation.receipts.issued.unknown);
  const voidAmount = singleCurrencyAmount(foundation.receipts.void.byCurrency, foundation.receipts.void.unknown);
  const vendorAmount = singleCurrencyAmount(foundation.vendorServiceCosts.byCurrency, foundation.vendorServiceCosts.unknown);
  const expenseAmount = singleCurrencyAmount(foundation.basicExpenses.byCurrency, foundation.basicExpenses.unknown);

  let billedIncome: number | null = null;
  let receivedIncome: number | null = null;
  let operationalCost: number | null = null;
  let netBilled: number | null = null;
  let netReceived: number | null = null;

  if (monetarySummary.singleCurrencyCode) {
    const cur = monetarySummary.byCurrency[monetarySummary.singleCurrencyCode];
    billedIncome = cur.billedIncome;
    receivedIncome = cur.receivedIncome;
    operationalCost = cur.operationalCost;
    netBilled = cur.netBilled;
    netReceived = cur.netReceived;
  } else if (monetarySummary.distinctKnownCurrencies.length === 0 && !monetarySummary.hasUnknown) {
    billedIncome = 0;
    receivedIncome = 0;
    operationalCost = 0;
    netBilled = 0;
    netReceived = 0;
  }

  const legacyByTenant = foundation.tenantBilling.byTenant.map((t) => {
    const codes = Object.keys(t.byCurrency);
    const hasUnknown = t.unknown.tenantChargeAmount !== 0 || t.unknown.utilityBillAmount !== 0 || t.unknown.invoiceAmount !== 0;
    if (codes.length === 1 && !hasUnknown) {
      const cur = t.byCurrency[codes[0]];
      return {
        tenantCompanyId: t.tenantCompanyId,
        tenantChargeAmount: cur.tenantChargeAmount,
        utilityBillAmount: cur.utilityBillAmount,
        invoiceAmount: cur.invoiceAmount,
        paidAmount: cur.paidAmount,
        outstandingAmount: cur.outstandingAmount,
      };
    }
    return {
      tenantCompanyId: t.tenantCompanyId,
      tenantChargeAmount: null,
      utilityBillAmount: null,
      invoiceAmount: null,
      paidAmount: null,
      outstandingAmount: null,
    };
  });

  return {
    buildingId,
    periodFrom: foundation.periodFrom,
    periodTo: foundation.periodTo,
    tenantCompanyId: foundation.tenantCompanyId,
    monetarySummary,
    tenantBilling: {
      tenantCharges: { count: foundation.tenantBilling.tenantCharges.totalActiveCount, amount: tcAmount, cancelledCount: foundation.tenantBilling.tenantCharges.cancelledCount },
      utilityBills: { count: foundation.tenantBilling.utilityBills.totalNonCancelledCount, amount: ubAmount, cancelledCount: foundation.tenantBilling.utilityBills.cancelledCount },
      byTenant: legacyByTenant,
    },
    invoicePayment: {
      invoices: { count: foundation.invoicePayment.invoices.finalizedCount, amount: invAmount, draftCount: foundation.invoicePayment.invoices.draftCount, cancelledCount: foundation.invoicePayment.invoices.cancelledCount },
      payments: {
        paidAmount,
        unpaidAmount,
        overdueAmount,
        outstandingAmount,
        unpaidCount: foundation.invoicePayment.payments.totalCounts.unpaidCount,
        partiallyPaidCount: foundation.invoicePayment.payments.totalCounts.partiallyPaidCount,
        paidCount: foundation.invoicePayment.payments.totalCounts.paidCount,
        overdueCount: foundation.invoicePayment.payments.totalCounts.overdueCount,
      },
    },
    receipts: {
      issued: { count: foundation.receipts.issued.totalCount, amount: issuedAmount },
      void: { count: foundation.receipts.void.totalCount, amount: voidAmount },
    },
    vendorServiceCosts: {
      finalized: { count: foundation.vendorServiceCosts.finalizedCount, amount: vendorAmount },
      draftCount: foundation.vendorServiceCosts.draftCount,
      cancelledCount: foundation.vendorServiceCosts.cancelledCount,
    },
    basicExpenses: {
      finalized: { count: foundation.basicExpenses.finalizedCount, amount: expenseAmount },
      draftCount: foundation.basicExpenses.draftCount,
      cancelledCount: foundation.basicExpenses.cancelledCount,
    },
    outstandingBalance: {
      invoiceCount: foundation.invoicePayment.payments.totalCounts.unpaidCount + foundation.invoicePayment.payments.totalCounts.partiallyPaidCount + foundation.invoicePayment.payments.totalCounts.overdueCount,
      amount: outstandingAmount,
    },
    incomeVsOperationalCost: {
      billedIncome,
      receivedIncome,
      operationalCost,
      netBilled,
      netReceived,
    },
    _currencySafeFoundation: foundation,
  };
}

export const basicFinancialReportingService = {
  getBasicFinancialSummary,
  getCurrencySafeFoundation,
  buildMonetarySummary,
};

export { buildMonetarySummary };
