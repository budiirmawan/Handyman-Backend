import type { BasicFinancialCurrencySafeFoundation, MonetarySummary, MonetarySummaryByCurrencyEntry } from './basic-financial-reporting.types';
import { add as decimalAdd, parseDecimal, toDecimalString } from '../fx-rates/fx-decimal';

// Exact decimal addition for same-currency amounts — uses fx-decimal BigInt authority, no float.
function exactAdd(a: number, b: number): number {
  const da = parseDecimal(String(a));
  const db = parseDecimal(String(b));
  const sum = decimalAdd(da, db);
  const str = toDecimalString(sum);
  return Number(str);
}

function exactSubtract(a: number, b: number): number {
  const da = parseDecimal(String(a));
  const db = parseDecimal(String(b));
  const negB = { unscaled: -db.unscaled, scale: db.scale };
  const diff = decimalAdd(da, negB);
  const str = toDecimalString(diff);
  return Number(str);
}

export function buildMonetarySummary(foundation: BasicFinancialCurrencySafeFoundation): MonetarySummary {
  const distinctKnownCurrencies = foundation.distinctKnownCurrencies;
  const hasUnknown = foundation.hasUnknown;

  const byCurrency: Record<string, MonetarySummaryByCurrencyEntry> = {};

  for (const code of distinctKnownCurrencies) {
    const tc = foundation.tenantBilling.tenantCharges.byCurrency[code] ?? { count: 0, amount: 0 };
    const ub = foundation.tenantBilling.utilityBills.byCurrency[code] ?? { count: 0, amount: 0 };
    const inv = foundation.invoicePayment.invoices.byCurrency[code] ?? { count: 0, amount: 0 };
    const pay = foundation.invoicePayment.payments.byCurrency[code] ?? {
      paidAmount: 0,
      unpaidAmount: 0,
      overdueAmount: 0,
      outstandingAmount: 0,
      unpaidCount: 0,
      partiallyPaidCount: 0,
      paidCount: 0,
      overdueCount: 0,
    };
    const recIssued = foundation.receipts.issued.byCurrency[code] ?? { count: 0, amount: 0 };
    const recVoid = foundation.receipts.void.byCurrency[code] ?? { count: 0, amount: 0 };
    const vsc = foundation.vendorServiceCosts.byCurrency[code] ?? { count: 0, amount: 0 };
    const be = foundation.basicExpenses.byCurrency[code] ?? { count: 0, amount: 0 };
    const unrepAmt = foundation.unrepresentedVendorCosts.byCurrency[code]?.amount ?? 0;

    const billedIncome = inv.amount;
    const receivedIncome = recIssued.amount;
    const operationalCost = exactAdd(be.amount, unrepAmt);
    const netBilled = exactSubtract(billedIncome, operationalCost);
    const netReceived = exactSubtract(receivedIncome, operationalCost);

    byCurrency[code] = {
      currencyCode: code,
      tenantCharges: { count: tc.count, amount: tc.amount },
      utilityBills: { count: ub.count, amount: ub.amount },
      invoices: { count: inv.count, amount: inv.amount },
      paidAmount: pay.paidAmount,
      unpaidAmount: pay.unpaidAmount,
      overdueAmount: pay.overdueAmount,
      outstandingAmount: pay.outstandingAmount,
      receiptsIssued: { count: recIssued.count, amount: recIssued.amount },
      receiptsVoid: { count: recVoid.count, amount: recVoid.amount },
      vendorServiceCosts: { count: vsc.count, amount: vsc.amount },
      basicExpenses: { count: be.count, amount: be.amount },
      unrepresentedVendorCosts: { amount: unrepAmt },
      billedIncome,
      receivedIncome,
      operationalCost,
      netBilled,
      netReceived,
    };
  }

  const unknown = {
    tenantCharges: foundation.tenantBilling.tenantCharges.unknown,
    utilityBills: foundation.tenantBilling.utilityBills.unknown,
    invoices: foundation.invoicePayment.invoices.unknown,
    paidAmount: {
      amount: foundation.invoicePayment.payments.unknown.paidAmount,
      count: foundation.invoicePayment.payments.unknown.paidCount + foundation.invoicePayment.payments.unknown.unpaidCount + foundation.invoicePayment.payments.unknown.partiallyPaidCount + foundation.invoicePayment.payments.unknown.overdueCount,
    },
    outstandingAmount: {
      amount: foundation.invoicePayment.payments.unknown.outstandingAmount,
      count: foundation.invoicePayment.payments.unknown.unpaidCount + foundation.invoicePayment.payments.unknown.partiallyPaidCount + foundation.invoicePayment.payments.unknown.overdueCount,
    },
    receiptsIssued: foundation.receipts.issued.unknown,
    receiptsVoid: foundation.receipts.void.unknown,
    vendorServiceCosts: foundation.vendorServiceCosts.unknown,
    basicExpenses: foundation.basicExpenses.unknown,
    unrepresentedVendorCosts: foundation.unrepresentedVendorCosts.unknown,
    byTenant: foundation.tenantBilling.byTenant
      .filter((t) => t.unknown.tenantChargeAmount !== 0 || t.unknown.utilityBillAmount !== 0 || t.unknown.invoiceAmount !== 0 || t.unknown.paidAmount !== 0 || t.unknown.outstandingAmount !== 0)
      .map((t) => ({
        tenantCompanyId: t.tenantCompanyId,
        tenantChargeAmount: t.unknown.tenantChargeAmount,
        utilityBillAmount: t.unknown.utilityBillAmount,
        invoiceAmount: t.unknown.invoiceAmount,
        paidAmount: t.unknown.paidAmount,
        outstandingAmount: t.unknown.outstandingAmount,
      })),
  };

  const singleCurrencyCode = distinctKnownCurrencies.length === 1 && !hasUnknown ? distinctKnownCurrencies[0] : null;

  return {
    byCurrency,
    unknown,
    distinctKnownCurrencies,
    hasUnknown,
    singleCurrencyCode,
  };
}

export { exactAdd, exactSubtract };
