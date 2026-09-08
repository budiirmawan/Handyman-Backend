export type FinancialReportFilters = {
  tenantCompanyId?: string;
  periodFrom?: string;
  periodTo?: string;
};

export type CountAmountSummary = { count: number; amount: number };

// ---------------------------------------------------------------------------
// PART 01 — Currency-safe foundation types (internal, not yet public API)
// ---------------------------------------------------------------------------

export type CurrencyBucket = {
  count: number;
  amount: number;
};

export type CurrencyGroupedBucket = {
  byCurrency: Record<string, CurrencyBucket>;
  unknown: CurrencyBucket;
};

export type TenantChargesCurrencySafe = {
  totalActiveCount: number;
  cancelledCount: number;
  byCurrency: Record<string, CurrencyBucket>;
  unknown: CurrencyBucket;
};

export type UtilityBillsCurrencySafe = {
  totalNonCancelledCount: number;
  cancelledCount: number;
  byCurrency: Record<string, CurrencyBucket>;
  unknown: CurrencyBucket;
};

export type ByTenantCurrencySafeEntry = {
  tenantCompanyId: string;
  byCurrency: Record<
    string,
    {
      tenantChargeAmount: number;
      utilityBillAmount: number;
      invoiceAmount: number;
      paidAmount: number;
      outstandingAmount: number;
    }
  >;
  unknown: {
    tenantChargeAmount: number;
    utilityBillAmount: number;
    invoiceAmount: number;
    paidAmount: number;
    outstandingAmount: number;
  };
};

export type TenantBillingCurrencySafe = {
  tenantCharges: TenantChargesCurrencySafe;
  utilityBills: UtilityBillsCurrencySafe;
  byTenant: ByTenantCurrencySafeEntry[];
};

export type InvoicesCurrencySafe = {
  finalizedCount: number;
  draftCount: number;
  cancelledCount: number;
  byCurrency: Record<string, CurrencyBucket>;
  unknown: CurrencyBucket;
};

export type PaymentCurrencyBucket = {
  paidAmount: number;
  unpaidAmount: number;
  overdueAmount: number;
  outstandingAmount: number;
  unpaidCount: number;
  partiallyPaidCount: number;
  paidCount: number;
  overdueCount: number;
};

export type PaymentsCurrencySafe = {
  byCurrency: Record<string, PaymentCurrencyBucket>;
  unknown: PaymentCurrencyBucket;
  totalCounts: {
    unpaidCount: number;
    partiallyPaidCount: number;
    paidCount: number;
    overdueCount: number;
  };
};

export type InvoicePaymentCurrencySafe = {
  invoices: InvoicesCurrencySafe;
  payments: PaymentsCurrencySafe;
};

export type ReceiptsCurrencySafe = {
  issued: {
    totalCount: number;
    byCurrency: Record<string, CurrencyBucket>;
    unknown: CurrencyBucket;
  };
  void: {
    totalCount: number;
    byCurrency: Record<string, CurrencyBucket>;
    unknown: CurrencyBucket;
  };
};

export type VendorServiceCostsCurrencySafe = {
  finalizedCount: number;
  draftCount: number;
  cancelledCount: number;
  byCurrency: Record<string, CurrencyBucket>;
  unknown: CurrencyBucket;
};

export type BasicExpensesCurrencySafe = {
  finalizedCount: number;
  draftCount: number;
  cancelledCount: number;
  byCurrency: Record<string, CurrencyBucket>;
  unknown: CurrencyBucket;
};

export type UnrepresentedVendorCostCurrencySafe = {
  byCurrency: Record<string, { amount: number }>;
  unknown: { amount: number };
};

export type BasicFinancialCurrencySafeFoundation = {
  buildingId: string;
  periodFrom: string | null;
  periodTo: string | null;
  tenantCompanyId: string | null;
  tenantBilling: TenantBillingCurrencySafe;
  invoicePayment: InvoicePaymentCurrencySafe;
  receipts: ReceiptsCurrencySafe;
  vendorServiceCosts: VendorServiceCostsCurrencySafe;
  basicExpenses: BasicExpensesCurrencySafe;
  unrepresentedVendorCosts: UnrepresentedVendorCostCurrencySafe;
  distinctKnownCurrencies: string[];
  hasUnknown: boolean;
};

// ---------------------------------------------------------------------------
// PART 02 — Authoritative monetarySummary by exact currency
// ---------------------------------------------------------------------------

export type MonetarySummaryByCurrencyEntry = {
  currencyCode: string;
  // Source amounts per currency (exact, same-currency only)
  tenantCharges: { count: number; amount: number };
  utilityBills: { count: number; amount: number };
  invoices: { count: number; amount: number };
  paidAmount: number;
  unpaidAmount: number;
  overdueAmount: number;
  outstandingAmount: number;
  receiptsIssued: { count: number; amount: number };
  receiptsVoid: { count: number; amount: number };
  vendorServiceCosts: { count: number; amount: number };
  basicExpenses: { count: number; amount: number };
  unrepresentedVendorCosts: { amount: number };
  // Derived per existing reporting semantics
  billedIncome: number;
  receivedIncome: number;
  operationalCost: number;
  netBilled: number;
  netReceived: number;
};

export type MonetarySummaryUnknown = {
  tenantCharges: CurrencyBucket;
  utilityBills: CurrencyBucket;
  invoices: CurrencyBucket;
  paidAmount: { amount: number; count: number };
  outstandingAmount: { amount: number; count: number };
  receiptsIssued: CurrencyBucket;
  receiptsVoid: CurrencyBucket;
  vendorServiceCosts: CurrencyBucket;
  basicExpenses: CurrencyBucket;
  unrepresentedVendorCosts: { amount: number };
  byTenant: Array<{
    tenantCompanyId: string;
    tenantChargeAmount: number;
    utilityBillAmount: number;
    invoiceAmount: number;
    paidAmount: number;
    outstandingAmount: number;
  }>;
};

export type MonetarySummary = {
  byCurrency: Record<string, MonetarySummaryByCurrencyEntry>;
  unknown: MonetarySummaryUnknown;
  distinctKnownCurrencies: string[];
  hasUnknown: boolean;
  // Convenience metadata for single-currency rule
  singleCurrencyCode: string | null;
};

// ---------------------------------------------------------------------------
// Public API — legacy shape now safe via nullable amounts + authoritative monetarySummary
// ---------------------------------------------------------------------------

export type PublicBasicFinancialSummary = {
  buildingId: string;
  periodFrom: string | null;
  periodTo: string | null;
  tenantCompanyId: string | null;
  // Authoritative currency-safe summary (PART 02)
  monetarySummary: MonetarySummary;
  // Legacy fields — nullable per single-currency convenience rule
  tenantBilling: {
    tenantCharges: { count: number; amount: number | null; cancelledCount: number };
    utilityBills: { count: number; amount: number | null; cancelledCount: number };
    byTenant: Array<{
      tenantCompanyId: string;
      tenantChargeAmount: number | null;
      utilityBillAmount: number | null;
      invoiceAmount: number | null;
      paidAmount: number | null;
      outstandingAmount: number | null;
    }>;
  };
  invoicePayment: {
    invoices: { count: number; amount: number | null; draftCount: number; cancelledCount: number };
    payments: {
      paidAmount: number | null;
      unpaidAmount: number | null;
      overdueAmount: number | null;
      outstandingAmount: number | null;
      unpaidCount: number;
      partiallyPaidCount: number;
      paidCount: number;
      overdueCount: number;
    };
  };
  receipts: {
    issued: { count: number; amount: number | null };
    void: { count: number; amount: number | null };
  };
  vendorServiceCosts: {
    finalized: { count: number; amount: number | null };
    draftCount: number;
    cancelledCount: number;
  };
  basicExpenses: {
    finalized: { count: number; amount: number | null };
    draftCount: number;
    cancelledCount: number;
  };
  outstandingBalance: { invoiceCount: number; amount: number | null };
  incomeVsOperationalCost: {
    billedIncome: number | null;
    receivedIncome: number | null;
    operationalCost: number | null;
    netBilled: number | null;
    netReceived: number | null;
  };
  // Internal foundation kept for backward compat with PART 01 tests
  _currencySafeFoundation?: BasicFinancialCurrencySafeFoundation;
};
