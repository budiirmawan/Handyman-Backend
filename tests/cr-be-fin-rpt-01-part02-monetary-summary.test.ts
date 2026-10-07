import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(__dirname, '..', 'src');
const SERVICE_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.service.ts');
const TYPES_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.types.ts');
const REPO_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.repository.ts');
const MIGRATION_DIR = join(SRC_ROOT, 'database', 'migrations');

function src(file: string) {
  return readFileSync(file, 'utf8');
}

describe('CR-BE-FIN-RPT-01 PART 02 — exact-currency income/cost/net', () => {
  it('types contain monetarySummary authoritative model', () => {
    const content = src(TYPES_PATH);
    assert.ok(content.includes('MonetarySummary'), 'must contain MonetarySummary');
    assert.ok(content.includes('MonetarySummaryByCurrencyEntry'), 'must contain MonetarySummaryByCurrencyEntry');
    assert.ok(content.includes('byCurrency'), 'must contain byCurrency');
    assert.ok(content.includes('billedIncome'), 'must contain billedIncome');
    assert.ok(content.includes('receivedIncome'), 'must contain receivedIncome');
    assert.ok(content.includes('operationalCost'), 'must contain operationalCost');
    assert.ok(content.includes('netBilled'), 'must contain netBilled');
    assert.ok(content.includes('netReceived'), 'must contain netReceived');
    assert.ok(content.includes('distinctKnownCurrencies'), 'must contain distinctKnownCurrencies');
    assert.ok(content.includes('hasUnknown'), 'must contain hasUnknown');
    assert.ok(content.includes('singleCurrencyCode'), 'must contain singleCurrencyCode');
  });

  it('service builds monetarySummary per exact currency', async () => {
    const mod = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const { buildMonetarySummary } = mod as any;
    assert.ok(typeof buildMonetarySummary === 'function', 'buildMonetarySummary must be exported');

    // IDR-only foundation
    const foundationIDR: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: ['IDR'],
      hasUnknown: false,
      tenantBilling: {
        tenantCharges: { byCurrency: { IDR: { count: 1, amount: 10000000 } }, unknown: { count: 0, amount: 0 } },
        utilityBills: { byCurrency: { IDR: { count: 1, amount: 2000000 } }, unknown: { count: 0, amount: 0 } },
        byTenant: [],
      },
      invoicePayment: {
        invoices: { byCurrency: { IDR: { count: 1, amount: 10000000 } }, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: { IDR: { paidAmount: 5000000, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 5000000, unpaidCount: 0, partiallyPaidCount: 1, paidCount: 0, overdueCount: 0 } },
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 0, partiallyPaidCount: 1, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: { IDR: { count: 1, amount: 5000000 } }, unknown: { count: 0, amount: 0 }, totalCount: 1 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: { IDR: { count: 1, amount: 1000000 } }, unknown: { count: 0, amount: 0 }, finalizedCount: 1, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: { IDR: { count: 1, amount: 2000000 } }, unknown: { count: 0, amount: 0 }, finalizedCount: 1, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: { IDR: { amount: 500000 } }, unknown: { amount: 0 } },
    };

    const summaryIDR = buildMonetarySummary(foundationIDR);
    assert.equal(summaryIDR.distinctKnownCurrencies.length, 1);
    assert.equal(summaryIDR.hasUnknown, false);
    assert.equal(summaryIDR.singleCurrencyCode, 'IDR');
    assert.ok(summaryIDR.byCurrency['IDR'], 'IDR entry must exist');
    const idr = summaryIDR.byCurrency['IDR'];
    assert.equal(idr.tenantCharges.amount, 10000000);
    assert.equal(idr.utilityBills.amount, 2000000);
    assert.equal(idr.invoices.amount, 10000000);
    assert.equal(idr.billedIncome, 10000000);
    assert.equal(idr.receivedIncome, 5000000);
    // operationalCost = basicExpenses + unrepresented = 2m + 0.5m = 2.5m
    assert.equal(idr.operationalCost, 2500000);
    assert.equal(idr.netBilled, 7500000);
    assert.equal(idr.netReceived, 2500000);
  });

  it('USD-only monetarySummary', async () => {
    const mod = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const { buildMonetarySummary } = mod as any;

    const foundationUSD: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: ['USD'],
      hasUnknown: false,
      tenantBilling: {
        tenantCharges: { byCurrency: { USD: { count: 1, amount: 500 } }, unknown: { count: 0, amount: 0 } },
        utilityBills: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        byTenant: [],
      },
      invoicePayment: {
        invoices: { byCurrency: { USD: { count: 1, amount: 500 } }, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: { USD: { paidAmount: 200, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 300, unpaidCount: 0, partiallyPaidCount: 1, paidCount: 0, overdueCount: 0 } },
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 0, partiallyPaidCount: 1, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: { USD: { count: 1, amount: 200 } }, unknown: { count: 0, amount: 0 }, totalCount: 1 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: { USD: { count: 1, amount: 100 } }, unknown: { count: 0, amount: 0 }, finalizedCount: 1, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: { USD: { count: 1, amount: 50 } }, unknown: { count: 0, amount: 0 }, finalizedCount: 1, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: { USD: { amount: 20 } }, unknown: { amount: 0 } },
    };

    const summary = buildMonetarySummary(foundationUSD);
    assert.equal(summary.singleCurrencyCode, 'USD');
    const usd = summary.byCurrency['USD'];
    assert.equal(usd.billedIncome, 500);
    assert.equal(usd.receivedIncome, 200);
    assert.equal(usd.operationalCost, 70); // 50+20
    assert.equal(usd.netBilled, 430);
    assert.equal(usd.netReceived, 130);
  });

  it('IDR + USD remain separate, union-of-currencies', async () => {
    const mod = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const { buildMonetarySummary } = mod as any;

    const foundationMixed: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: ['IDR', 'USD'],
      hasUnknown: false,
      tenantBilling: {
        tenantCharges: { byCurrency: { IDR: { count: 1, amount: 10000000 }, USD: { count: 1, amount: 500 } }, unknown: { count: 0, amount: 0 } },
        utilityBills: { byCurrency: { IDR: { count: 1, amount: 2000000 } }, unknown: { count: 0, amount: 0 } },
        byTenant: [],
      },
      invoicePayment: {
        invoices: { byCurrency: { IDR: { count: 1, amount: 10000000 }, USD: { count: 1, amount: 500 } }, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: {
            IDR: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 10000000, unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
            USD: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 500, unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          },
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 2, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: { IDR: { count: 1, amount: 0 } }, unknown: { count: 0, amount: 0 }, totalCount: 1 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: { IDR: { count: 1, amount: 1000000 } }, unknown: { count: 0, amount: 0 }, finalizedCount: 1, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: { IDR: { count: 1, amount: 2000000 } }, unknown: { count: 0, amount: 0 }, finalizedCount: 1, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: { IDR: { amount: 500000 } }, unknown: { amount: 0 } },
    };

    const summary = buildMonetarySummary(foundationMixed);
    assert.equal(Object.keys(summary.byCurrency).length, 2);
    assert.ok(summary.byCurrency['IDR']);
    assert.ok(summary.byCurrency['USD']);
    assert.equal(summary.byCurrency['IDR'].billedIncome, 10000000);
    assert.equal(summary.byCurrency['USD'].billedIncome, 500);
    // USD has no cost, so operationalCost 0, net = income
    assert.equal(summary.byCurrency['USD'].operationalCost, 0);
    assert.equal(summary.byCurrency['USD'].netBilled, 500);
    // IDR operationalCost = 2.5m, net = 7.5m
    assert.equal(summary.byCurrency['IDR'].operationalCost, 2500000);
    assert.equal(summary.byCurrency['IDR'].netBilled, 7500000);
    // No cross-currency subtraction
    assert.notEqual(summary.byCurrency['IDR'].netBilled, 10000000 - 500, 'must not subtract USD cost from IDR income');
  });

  it('missing cost side treated as zero for same currency', async () => {
    const mod = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const { buildMonetarySummary } = mod as any;

    const foundation: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: ['IDR'],
      hasUnknown: false,
      tenantBilling: {
        tenantCharges: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        utilityBills: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        byTenant: [],
      },
      invoicePayment: {
        invoices: { byCurrency: { IDR: { count: 1, amount: 10000000 } }, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: { IDR: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 10000000, unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 } },
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
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
    const idr = summary.byCurrency['IDR'];
    // No cost, so operationalCost 0, net = income
    assert.equal(idr.operationalCost, 0);
    assert.equal(idr.netBilled, 10000000);
    assert.equal(idr.netReceived, 0);
  });

  it('missing income side treated as zero for same currency', async () => {
    const mod = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const { buildMonetarySummary } = mod as any;

    const foundation: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: ['USD'],
      hasUnknown: false,
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
      vendorServiceCosts: { byCurrency: { USD: { count: 1, amount: 100 } }, unknown: { count: 0, amount: 0 }, finalizedCount: 1, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: { USD: { count: 1, amount: 200 } }, unknown: { count: 0, amount: 0 }, finalizedCount: 1, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: { USD: { amount: 50 } }, unknown: { amount: 0 } },
    };

    const summary = buildMonetarySummary(foundation);
    const usd = summary.byCurrency['USD'];
    assert.equal(usd.billedIncome, 0);
    assert.equal(usd.receivedIncome, 0);
    assert.equal(usd.operationalCost, 250); // 200+50
    assert.equal(usd.netBilled, -250);
    assert.equal(usd.netReceived, -250);
  });

  it('UNKNOWN excluded from byCurrency and prevents legacy scalars', async () => {
    const mod = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const { buildMonetarySummary } = mod as any;

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
        invoices: { byCurrency: { IDR: { count: 1, amount: 1000 } }, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: { IDR: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 1000, unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 } },
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
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
    assert.equal(summary.hasUnknown, true);
    assert.equal(summary.singleCurrencyCode, null, 'singleCurrencyCode must be null when unknown exists');
    assert.equal(summary.byCurrency['IDR'].tenantCharges.amount, 1000, 'known IDR amount must exclude unknown');
    assert.equal(summary.unknown.tenantCharges.amount, 999);
    assert.equal(summary.unknown.tenantCharges.count, 1);
  });

  it('no FX import and no unsafe Number arithmetic in service', () => {
    const serviceContent = src(SERVICE_PATH);
    const monetaryContent = readFileSync(join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.monetary-summary.ts'), 'utf8');
    const combined = serviceContent + '\n' + monetaryContent;
    assert.ok(!serviceContent.includes('fxConversionService'), 'service must not import fxConversionService');
    assert.ok(!serviceContent.includes('fx_rates'), 'service must not reference fx_rates');
    assert.ok(!/amount\s*\*\s*rate/.test(combined), 'must not contain amount * rate');
    assert.ok(!/amount\s*\/\s*rate/.test(combined), 'must not contain amount / rate');
    // Must reuse fx-decimal for exact arithmetic (in monetary-summary)
    assert.ok(monetaryContent.includes('fx-decimal') || monetaryContent.includes('decimalAdd') || monetaryContent.includes('parseDecimal'), 'must reuse safe decimal helper in monetary-summary');
    // Must not use Math.round, toFixed, parseFloat for monetary net in monetary-summary
    const lines = monetaryContent.split('\n').filter((l) => l.includes('operationalCost') || l.includes('netBilled') || l.includes('netReceived') || l.includes('exactAdd') || l.includes('exactSubtract'));
    for (const line of lines) {
      assert.ok(!line.includes('Math.round'), `net line must not use Math.round: ${line}`);
      assert.ok(!line.includes('toFixed'), `net line must not use toFixed: ${line}`);
      assert.ok(!line.includes('parseFloat'), `net line must not use parseFloat: ${line}`);
    }
  });

  it('no migration 0334', () => {
    const fs = require('node:fs');
    const files = fs.readdirSync(MIGRATION_DIR) as string[];
    const has0334 = files.some((f: string) => f.startsWith('0334'));
    assert.ok(!has0334, '0334 must not exist');
  });

  it('isolation preserved in repository', () => {
    const content = src(REPO_PATH);
    assert.ok(content.includes('building_id'), 'must filter by building_id');
    assert.ok(content.includes('assertBuildingAccess') || src(SERVICE_PATH).includes('assertBuildingAccess'), 'service must check building access');
  });

  it('counts remain scalar and unaffected', () => {
    const typesContent = src(TYPES_PATH);
    // Count fields should still be number (not nullable) for counts
    assert.ok(typesContent.includes('count: number'), 'count fields must remain number');
    // But amount fields nullable
    assert.ok(typesContent.includes('amount: number | null') || typesContent.includes('amount: number'), 'amount fields must be nullable or number');
  });
});
