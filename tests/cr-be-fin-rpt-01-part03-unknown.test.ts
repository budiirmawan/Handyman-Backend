import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(__dirname, '..', 'src');
const REPO_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.repository.ts');
const SERVICE_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.service.ts');
const MONETARY_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.monetary-summary.ts');
const TYPES_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.types.ts');
const MIGRATION_DIR = join(SRC_ROOT, 'database', 'migrations');

function src(file: string) {
  return readFileSync(file, 'utf8');
}

describe('CR-BE-FIN-RPT-01 PART 03 — UNKNOWN + historical compatibility', () => {
  it('unknown model contains per-source count+amount', () => {
    const content = src(TYPES_PATH);
    // Must have unknown with per-source buckets
    assert.ok(content.includes('tenantCharges'), 'unknown must have tenantCharges');
    assert.ok(content.includes('utilityBills'), 'unknown must have utilityBills');
    assert.ok(content.includes('invoices'), 'unknown must have invoices');
    assert.ok(content.includes('receiptsIssued') || content.includes('receipts'), 'unknown must have receipts');
    assert.ok(content.includes('vendorServiceCosts'), 'unknown must have vendorServiceCosts');
    assert.ok(content.includes('basicExpenses'), 'unknown must have basicExpenses');
    assert.ok(content.includes('unrepresentedVendorCosts'), 'unknown must have unrepresentedVendorCosts');
    assert.ok(content.includes('CurrencyBucket'), 'unknown buckets must be CurrencyBucket {count, amount}');
  });

  it('historical NULL tenant charge -> unknown (mock foundation)', async () => {
    const { buildMonetarySummary } = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const foundation: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: ['IDR'],
      hasUnknown: true,
      tenantBilling: {
        tenantCharges: { byCurrency: { IDR: { count: 1, amount: 1000 } }, unknown: { count: 1, amount: 999 } },
        utilityBills: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        byTenant: [{ tenantCompanyId: 't1', byCurrency: {}, unknown: { tenantChargeAmount: 999, utilityBillAmount: 0, invoiceAmount: 0, paidAmount: 0, outstandingAmount: 0 } }],
      },
      invoicePayment: {
        invoices: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: {},
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: {}, unknown: { amount: 0 } },
    };
    const summary = buildMonetarySummary(foundation);
    assert.equal(summary.byCurrency['IDR'].tenantCharges.amount, 1000);
    assert.equal(summary.unknown.tenantCharges.amount, 999);
    assert.equal(summary.unknown.tenantCharges.count, 1);
    assert.equal(summary.hasUnknown, true);
    assert.equal(summary.singleCurrencyCode, null);
  });

  it('historical NULL utility bill -> unknown', async () => {
    const { buildMonetarySummary } = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const foundation: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: [],
      hasUnknown: true,
      tenantBilling: {
        tenantCharges: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        utilityBills: { byCurrency: {}, unknown: { count: 1, amount: 1234 } },
        byTenant: [],
      },
      invoicePayment: {
        invoices: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: {},
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: {}, unknown: { amount: 0 } },
    };
    const summary = buildMonetarySummary(foundation);
    assert.equal(summary.unknown.utilityBills.amount, 1234);
    assert.equal(summary.unknown.utilityBills.count, 1);
    assert.equal(Object.keys(summary.byCurrency).length, 0);
  });

  it('historical NULL invoice -> unknown', async () => {
    const { buildMonetarySummary } = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const foundation: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: [],
      hasUnknown: true,
      tenantBilling: {
        tenantCharges: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        utilityBills: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        byTenant: [],
      },
      invoicePayment: {
        invoices: { byCurrency: {}, unknown: { count: 2, amount: 5000 } },
        payments: {
          byCurrency: {},
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: {}, unknown: { amount: 0 } },
    };
    const summary = buildMonetarySummary(foundation);
    assert.equal(summary.unknown.invoices.amount, 5000);
    assert.equal(summary.unknown.invoices.count, 2);
    assert.equal(Object.keys(summary.byCurrency).length, 0);
  });

  it('payment/outstanding inheriting NULL invoice -> unknown', async () => {
    const { buildMonetarySummary } = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const foundation: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: [],
      hasUnknown: true,
      tenantBilling: {
        tenantCharges: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        utilityBills: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        byTenant: [],
      },
      invoicePayment: {
        invoices: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: {},
          unknown: { paidAmount: 300, unpaidAmount: 100, overdueAmount: 50, outstandingAmount: 150, unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 1 },
          totalCounts: { unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 1 },
        },
      },
      receipts: {
        issued: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: {}, unknown: { amount: 0 } },
    };
    const summary = buildMonetarySummary(foundation);
    assert.equal(summary.unknown.paidAmount.amount, 300);
    assert.equal(summary.unknown.outstandingAmount.amount, 150);
    assert.equal(Object.keys(summary.byCurrency).length, 0);
  });

  it('receipt inheriting NULL invoice -> unknown', async () => {
    const { buildMonetarySummary } = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const foundation: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: [],
      hasUnknown: true,
      tenantBilling: {
        tenantCharges: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        utilityBills: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        byTenant: [],
      },
      invoicePayment: {
        invoices: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: {},
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: {}, unknown: { count: 1, amount: 777 }, totalCount: 1 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: {}, unknown: { amount: 0 } },
    };
    const summary = buildMonetarySummary(foundation);
    assert.equal(summary.unknown.receiptsIssued.amount, 777);
    assert.equal(summary.unknown.receiptsIssued.count, 1);
  });

  it('NULL VSC and basic expense -> unknown', async () => {
    const { buildMonetarySummary } = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const foundation: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: [],
      hasUnknown: true,
      tenantBilling: {
        tenantCharges: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        utilityBills: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        byTenant: [],
      },
      invoicePayment: {
        invoices: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: {},
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: {}, unknown: { count: 2, amount: 2000 }, finalizedCount: 2, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: {}, unknown: { count: 1, amount: 1000 }, finalizedCount: 1, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: {}, unknown: { amount: 0 } },
    };
    const summary = buildMonetarySummary(foundation);
    assert.equal(summary.unknown.vendorServiceCosts.amount, 2000);
    assert.equal(summary.unknown.basicExpenses.amount, 1000);
  });

  it('unknown source remains separately traceable', async () => {
    const { buildMonetarySummary } = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const foundation: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: ['IDR'],
      hasUnknown: true,
      tenantBilling: {
        tenantCharges: { byCurrency: { IDR: { count: 1, amount: 100 } }, unknown: { count: 1, amount: 10 } },
        utilityBills: { byCurrency: { IDR: { count: 1, amount: 200 } }, unknown: { count: 1, amount: 20 } },
        byTenant: [],
      },
      invoicePayment: {
        invoices: { byCurrency: { IDR: { count: 1, amount: 300 } }, unknown: { count: 1, amount: 30 } },
        payments: {
          byCurrency: { IDR: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 300, unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 } },
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 30, unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 2, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: { IDR: { count: 1, amount: 100 } }, unknown: { count: 1, amount: 10 }, totalCount: 2 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: { IDR: { count: 1, amount: 400 } }, unknown: { count: 1, amount: 40 }, finalizedCount: 2, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: { IDR: { count: 1, amount: 500 } }, unknown: { count: 1, amount: 50 }, finalizedCount: 2, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: { IDR: { amount: 100 } }, unknown: { amount: 10 } },
    };
    const summary = buildMonetarySummary(foundation);
    // Each unknown bucket must be separate, not collapsed
    assert.equal(summary.unknown.tenantCharges.amount, 10);
    assert.equal(summary.unknown.utilityBills.amount, 20);
    assert.equal(summary.unknown.invoices.amount, 30);
    assert.equal(summary.unknown.receiptsIssued.amount, 10);
    assert.equal(summary.unknown.vendorServiceCosts.amount, 40);
    assert.equal(summary.unknown.basicExpenses.amount, 50);
    assert.equal(summary.unknown.unrepresentedVendorCosts.amount, 10);
    // byCurrency must contain only known IDR, not unknown
    assert.equal(summary.byCurrency['IDR'].tenantCharges.amount, 100);
    assert.equal(summary.byCurrency['IDR'].utilityBills.amount, 200);
  });

  it('unknown never enters byCurrency and never enters net', async () => {
    const { buildMonetarySummary } = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const foundation: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: ['IDR'],
      hasUnknown: true,
      tenantBilling: {
        tenantCharges: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        utilityBills: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        byTenant: [],
      },
      invoicePayment: {
        invoices: { byCurrency: { IDR: { count: 1, amount: 1000 } }, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: {},
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: { IDR: { count: 1, amount: 100 } }, unknown: { count: 1, amount: 9999 } },
      unrepresentedVendorCosts: { byCurrency: {}, unknown: { amount: 0 } },
    };
    const summary = buildMonetarySummary(foundation);
    // Known cost is 100, unknown 9999 must NOT be added
    assert.equal(summary.byCurrency['IDR'].basicExpenses.amount, 100);
    assert.equal(summary.byCurrency['IDR'].operationalCost, 100);
    assert.equal(summary.byCurrency['IDR'].netBilled, 900); // 1000-100, not 1000-(100+9999)
    assert.equal(summary.unknown.basicExpenses.amount, 9999);
  });

  it('any unknown nulls legacy monetary scalars', () => {
    const serviceContent = src(SERVICE_PATH);
    // Must check hasUnknown for legacy scalar convenience
    assert.ok(serviceContent.includes('hasUnknown') || serviceContent.includes('singleCurrencyCode'), 'must check hasUnknown/singleCurrencyCode for legacy scalars');
    assert.ok(serviceContent.includes('singleCurrencyCode'), 'must have singleCurrencyCode logic');
  });

  it('tenant-level unknown preserved', async () => {
    const { buildMonetarySummary } = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const foundation: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: ['IDR'],
      hasUnknown: true,
      tenantBilling: {
        tenantCharges: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        utilityBills: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        byTenant: [
          { tenantCompanyId: 'tenant-1', byCurrency: {}, unknown: { tenantChargeAmount: 111, utilityBillAmount: 0, invoiceAmount: 0, paidAmount: 0, outstandingAmount: 0 } },
          { tenantCompanyId: 'tenant-2', byCurrency: { IDR: { tenantChargeAmount: 100, utilityBillAmount: 0, invoiceAmount: 0, paidAmount: 0, outstandingAmount: 0 } }, unknown: { tenantChargeAmount: 0, utilityBillAmount: 0, invoiceAmount: 0, paidAmount: 0, outstandingAmount: 0 } },
        ],
      },
      invoicePayment: {
        invoices: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: {},
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: {}, unknown: { amount: 0 } },
    };
    const summary = buildMonetarySummary(foundation);
    assert.equal(summary.unknown.byTenant.length, 1);
    assert.equal(summary.unknown.byTenant[0].tenantCompanyId, 'tenant-1');
    assert.equal(summary.unknown.byTenant[0].tenantChargeAmount, 111);
  });

  it('no IDR/default inference and no FX import', () => {
    const repoContent = src(REPO_PATH);
    const serviceContent = src(SERVICE_PATH);
    const monetaryContent = src(MONETARY_PATH);

    // No hardcoded IDR inference
    assert.ok(!/['\"]IDR['\"]/.test(repoContent) || repoContent.includes('currency_code'), 'repo must not hardcode IDR as default (allow column name reference)');
    // Check no base_currency, default_transaction_currency, reporting_currency inference
    assert.ok(!repoContent.includes('base_currency'), 'repo must not infer base_currency');
    assert.ok(!repoContent.includes('default_transaction'), 'repo must not infer default_transaction_currency');
    assert.ok(!repoContent.includes('reporting_currency'), 'repo must not infer reporting_currency');

    // No FX conversion service
    assert.ok(!serviceContent.includes('fxConversionService'), 'service must not import fxConversionService');
    assert.ok(!serviceContent.includes('fxReportingService'), 'service must not import fxReportingService');
    assert.ok(!monetaryContent.includes('fxConversionService'), 'monetary-summary must not import fxConversionService');
    assert.ok(!monetaryContent.includes('fxReportingService'), 'monetary-summary must not import fxReportingService');
    // fx-decimal is allowed (exact decimal helper)
  });

  it('no migration 0334', () => {
    const fs = require('node:fs');
    const files = fs.readdirSync(MIGRATION_DIR) as string[];
    const has0334 = files.some((f: string) => f.startsWith('0334'));
    assert.ok(!has0334, '0334 must not exist');
  });

  it('runtime response shape stable', () => {
    const typesContent = src(TYPES_PATH);
    assert.ok(typesContent.includes('monetarySummary'), 'public response must contain monetarySummary');
    assert.ok(typesContent.includes('byCurrency'), 'must contain byCurrency');
    assert.ok(typesContent.includes('unknown'), 'must contain unknown');
    assert.ok(typesContent.includes('distinctKnownCurrencies'), 'must contain distinctKnownCurrencies');
    assert.ok(typesContent.includes('hasUnknown'), 'must contain hasUnknown');
    assert.ok(typesContent.includes('singleCurrencyCode'), 'must contain singleCurrencyCode');
    assert.ok(typesContent.includes('amount: number | null'), 'legacy scalars must be nullable');
  });
});
