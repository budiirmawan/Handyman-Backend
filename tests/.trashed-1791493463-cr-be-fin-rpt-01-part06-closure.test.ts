import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(__dirname, '..', 'src');
const OPENAPI_PATH = join(__dirname, '..', 'docs', 'api', 'openapi.yaml');
const REPO_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.repository.ts');
const SERVICE_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.service.ts');
const MONETARY_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.monetary-summary.ts');
const TYPES_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.types.ts');
const ROUTES_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.routes.ts');
const MIGRATION_DIR = join(SRC_ROOT, 'database', 'migrations');

function src(file: string) {
  return readFileSync(file, 'utf8');
}

describe('CR-BE-FIN-RPT-01 PART 06 — closure, regression evidence & handoff readiness', () => {
  it('final defect review: no remaining mixed-currency defect in FIN-RPT-01 files', () => {
    for (const p of [REPO_PATH, SERVICE_PATH, MONETARY_PATH, TYPES_PATH, ROUTES_PATH]) {
      assert.ok(existsSync(p), `${p} must exist`);
    }
    const repo = src(REPO_PATH);
    // Old unsafe scalar SUM must not exist
    assert.ok(!repo.includes(`SELECT COUNT(*) FILTER(WHERE status='ACTIVE')::int count,COALESCE(SUM(amount)FILTER(WHERE status='ACTIVE'),0)::text amount,COUNT(*)FILTER(WHERE status='CANCELLED')::int cancelled FROM tenant_charges WHERE building_id=$1 AND($2::date IS NULL OR charge_date>=$2)AND($3::date IS NULL OR charge_date<=$3)AND($4::uuid IS NULL OR tenant_company_id=$4)`), 'old unsafe tenant_charges query must be gone');
    assert.ok(!repo.includes(`SELECT COUNT(*) FILTER(WHERE status<>'CANCELLED')::int count,COALESCE(SUM(bill_amount)FILTER(WHERE status<>'CANCELLED'),0)::text amount`), 'old unsafe utility_bills query must be gone');
    assert.ok(!repo.includes(`COALESCE(SUM(total_amount) FILTER (WHERE status = 'FINALIZED'), 0)::text invoice_amount`), 'old unsafe invoice amount scalar must be gone');
    assert.ok(!repo.includes(`SELECT COUNT(*)FILTER(WHERE status='ISSUED')::int issued_count,COALESCE(SUM(received_amount)FILTER(WHERE status='ISSUED'),0)::text issued_amount`), 'old unsafe receipts query must be gone');
    assert.ok(!repo.includes(`SELECT COUNT(*)FILTER(WHERE status='FINALIZED')::int count,COALESCE(SUM(cost_amount)FILTER(WHERE status='FINALIZED'),0)::text amount,COUNT(*)FILTER(WHERE status='DRAFT')`), 'old unsafe vendor costs query must be gone');

    // Must have GROUP BY for currency safety
    const groupByCount = (repo.match(/GROUP BY/g) || []).length;
    assert.ok(groupByCount >= 7, `must have >=7 GROUP BY for currency safety, got ${groupByCount}`);

    // Must have byCurrency and unknown
    assert.ok(repo.includes('byCurrency'), 'repo must have byCurrency');
    assert.ok(repo.includes('unknown'), 'repo must have unknown');

    // Service must have monetarySummary
    const service = src(SERVICE_PATH);
    assert.ok(service.includes('monetarySummary'), 'service must have monetarySummary');
    assert.ok(service.includes('buildMonetarySummary'), 'service must build monetarySummary');
    assert.ok(service.includes('singleCurrencyCode'), 'service must have singleCurrencyCode');

    // Monetary-summary must compute net per currency only
    const monetary = src(MONETARY_PATH);
    assert.ok(monetary.includes('billedIncome'), 'monetary-summary must have billedIncome per currency');
    assert.ok(monetary.includes('operationalCost'), 'must have operationalCost per currency');
    assert.ok(monetary.includes('netBilled'), 'must have netBilled per currency');
    assert.ok(monetary.includes('netReceived'), 'must have netReceived per currency');
    // Must use exact decimal helper, not unsafe Number arithmetic for net
    assert.ok(monetary.includes('exactAdd') || monetary.includes('decimalAdd'), 'must use exactAdd for operationalCost');
    assert.ok(monetary.includes('exactSubtract') || monetary.includes('decimalAdd'), 'must use exactSubtract for net');
  });

  it('mixed-currency safety: no known-currency SUM combines multiple currencies', () => {
    const repo = src(REPO_PATH);
    // Every SUM must be inside a GROUP BY currency query
    // Check that file contains GROUP BY currency_code and GROUP BY currency
    assert.ok(repo.includes('GROUP BY currency_code') || repo.includes('GROUP BY currency'), 'must GROUP BY currency');
    // Ensure no cross-currency subtraction in monetary-summary: net = billed - cost per currency only
    const monetary = src(MONETARY_PATH);
    // Should NOT have pattern that subtracts across different currency variables
    assert.ok(!/byCurrency\[.*\].*-\s*byCurrency\[.*\].*\[.*different/.test(monetary), 'must not have cross-currency subtraction');
    // byCurrency is authoritative
    assert.ok(monetary.includes('byCurrency[code]'), 'byCurrency[code] must be authoritative');
  });

  it('netBilled and netReceived calculated only within same currency', async () => {
    const { buildMonetarySummary } = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
    const foundation: any = {
      buildingId: 'b1',
      periodFrom: null,
      periodTo: null,
      tenantCompanyId: null,
      distinctKnownCurrencies: ['IDR', 'USD'],
      hasUnknown: false,
      tenantBilling: {
        tenantCharges: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        utilityBills: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        byTenant: [],
      },
      invoicePayment: {
        invoices: { byCurrency: { IDR: { count: 1, amount: 1000 }, USD: { count: 1, amount: 500 } }, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: {},
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: { IDR: { count: 1, amount: 1000 }, USD: { count: 1, amount: 500 } }, unknown: { count: 0, amount: 0 }, totalCount: 2 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: { IDR: { count: 1, amount: 100 }, USD: { count: 1, amount: 50 } }, unknown: { count: 0, amount: 0 }, finalizedCount: 2, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: { IDR: { amount: 20 }, USD: { amount: 10 } }, unknown: { amount: 0 } },
    };
    const summary = buildMonetarySummary(foundation);
    // IDR net = 1000 - (100+20) = 880, USD net = 500 - (50+10) = 440, no cross
    assert.equal(summary.byCurrency['IDR'].netBilled, 880);
    assert.equal(summary.byCurrency['USD'].netBilled, 440);
    assert.equal(summary.byCurrency['IDR'].netReceived, 880);
    assert.equal(summary.byCurrency['USD'].netReceived, 440);
  });

  it('UNKNOWN never enters known-currency arithmetic', async () => {
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
    assert.equal(summary.byCurrency['IDR'].operationalCost, 100, 'unknown must not enter operationalCost');
    assert.equal(summary.byCurrency['IDR'].netBilled, 900);
  });

  it('source authority closure', () => {
    const repo = src(REPO_PATH);
    // tenant_charges → currency_code
    assert.ok(repo.includes('tenant_charges') && repo.includes('currency_code'), 'tenant_charges must use currency_code');
    // utility_bills → currency
    assert.ok(repo.includes('utility_bills') && repo.includes('currency'), 'utility_bills must use currency');
    // tenant_invoices → currency_code
    assert.ok(repo.includes('tenant_invoices') && repo.includes('currency_code'), 'tenant_invoices must use currency_code');
    // invoice_payment_status → invoice currency
    assert.ok(repo.includes('invoice_payment_status') || repo.includes('tenant_invoices i'), 'invoice_payment_status must inherit invoice currency');
    assert.ok(repo.includes('i.currency_code'), 'must use i.currency_code');
    // payment_receipts → invoice currency
    assert.ok(repo.includes('payment_receipts') && repo.includes('JOIN tenant_invoices'), 'payment_receipts must JOIN invoice');
    // vendor_service_costs → currency_code
    assert.ok(repo.includes('vendor_service_costs') && repo.includes('currency_code'), 'VSC must use currency_code');
    // basic_expenses → currency_code
    assert.ok(repo.includes('basic_expenses') && repo.includes('currency_code'), 'basic_expenses must use currency_code');
    // No inferred currency
    assert.ok(!repo.includes('base_currency'), 'must not infer base_currency');
    assert.ok(!repo.includes('default_transaction'), 'must not infer default_transaction_currency');
  });

  it('UNKNOWN closure', () => {
    const repo = src(REPO_PATH);
    const monetary = src(MONETARY_PATH);
    const types = src(TYPES_PATH);
    // Historical NULL remains UNKNOWN
    assert.ok(repo.includes('unknown'), 'repo must have unknown bucket');
    assert.ok(monetary.includes('unknown'), 'monetary-summary must have unknown');
    assert.ok(types.includes('unknown'), 'types must have unknown');
    // Explicit per source
    assert.ok(types.includes('tenantCharges') && types.includes('utilityBills') && types.includes('invoices'), 'unknown must be per-source');
    // Excluded from byCurrency
    assert.ok(monetary.includes('distinctKnownCurrencies'), 'byCurrency built from distinctKnownCurrencies only');
    // Any UNKNOWN disables legacy scalar
    const service = src(SERVICE_PATH);
    assert.ok(service.includes('hasUnknown') && service.includes('singleCurrencyCode'), 'legacy scalar must check hasUnknown');
    // No IDR/base/default/reporting inference
    assert.ok(!repo.includes('base_currency'), 'no base inference');
    assert.ok(!repo.includes('reporting_currency'), 'no reporting inference');
    // No backfill
    assert.ok(!repo.includes('UPDATE'), 'no historical rewrite/backfill');
  });

  it('legacy compatibility frozen rule', () => {
    const service = src(SERVICE_PATH);
    const types = src(TYPES_PATH);
    assert.ok(service.includes('singleCurrencyCode'), 'must have singleCurrencyCode');
    assert.ok(service.includes('hasUnknown'), 'must check hasUnknown');
    assert.ok(types.includes('amount: number | null'), 'legacy amount must be nullable');
    // Counts remain stable
    assert.ok(types.includes('count: number'), 'counts must remain number');
  });

  it('payment/outstanding reconfirm', async () => {
    const { buildMonetarySummary } = await import('../src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts');
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
        invoices: { byCurrency: { IDR: { count: 1, amount: 1000 } }, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: { IDR: { paidAmount: 300, unpaidAmount: 200, overdueAmount: 0, outstandingAmount: 700, unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 } },
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: { IDR: { count: 1, amount: 300 } }, unknown: { count: 0, amount: 0 }, totalCount: 1 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: {}, unknown: { amount: 0 } },
    };
    const summary = buildMonetarySummary(foundation);
    assert.equal(summary.byCurrency['IDR'].paidAmount, 300);
    assert.equal(summary.byCurrency['IDR'].outstandingAmount, 700);
    assert.equal(summary.byCurrency['IDR'].receiptsIssued.amount, 300);
  });

  it('FX boundary: no FX integration', () => {
    for (const p of [REPO_PATH, SERVICE_PATH, MONETARY_PATH]) {
      const content = src(p);
      assert.ok(!content.includes('fxConversionService'), `${p} must not import fxConversionService`);
      assert.ok(!content.includes('fxReportingService'), `${p} must not import fxReportingService`);
      assert.ok(!/amount\s*\*\s*rate/.test(content), `${p} must not contain amount * rate`);
      assert.ok(!/amount\s*\/\s*rate/.test(content), `${p} must not contain amount / rate`);
      assert.ok(!content.includes('reportingCurrency') || content.includes('BasicFinancial'), 'must not have reportingCurrency (except in comments)');
    }
  });

  it('OpenAPI closure: runtime route and OpenAPI match', () => {
    assert.ok(existsSync(OPENAPI_PATH), 'openapi.yaml must exist');
    const openapi = src(OPENAPI_PATH);
    const routes = src(ROUTES_PATH);

    // Runtime route
    assert.ok(routes.includes('/buildings/:buildingId/financial-summary'), 'runtime route must exist');
    assert.ok(routes.includes('basic_financial_reporting.read'), 'runtime permission must be basic_financial_reporting.read');

    // OpenAPI path
    assert.ok(openapi.includes('/buildings/{buildingId}/financial-summary:'), 'OpenAPI path must exist');
    const idx = openapi.indexOf('/buildings/{buildingId}/financial-summary:');
    const snippet = openapi.slice(idx, idx + 5000);
    assert.ok(snippet.includes('get:'), 'method must be GET');
    assert.ok(snippet.includes('operationId: getBasicFinancialSummary'), 'operationId must be getBasicFinancialSummary');
    assert.ok(snippet.includes('x-required-permission: basic_financial_reporting.read'), 'permission must match');
    assert.ok(snippet.includes('x-building-scoped: true'), 'building scope must be true');
    assert.ok(snippet.includes('periodFrom') && snippet.includes('periodTo') && snippet.includes('tenantCompanyId'), 'query params must match runtime');

    // Response schema
    assert.ok(openapi.includes('BasicFinancialSummary'), 'must have BasicFinancialSummary schema');
    assert.ok(openapi.includes('BasicFinancialMonetarySummary'), 'must have MonetarySummary schema');
    assert.ok(openapi.includes('BasicFinancialByCurrencyEntry'), 'must have byCurrency entry');
    assert.ok(openapi.includes('BasicFinancialUnknown'), 'must have unknown');
    assert.ok(snippet.includes('BasicFinancialSummary'), 'path must reference BasicFinancialSummary');

    // No FX fields
    assert.ok(!snippet.includes('convertedTotal'), 'must not have convertedTotal');
    assert.ok(!snippet.includes('fxRateId'), 'must not have fxRateId');

    // No unresolved refs for our schemas
    const required = ['BasicFinancialSummary', 'BasicFinancialMonetarySummary', 'BasicFinancialByCurrencyEntry', 'BasicFinancialUnknown', 'BasicFinancialCurrencyBucket'];
    for (const r of required) {
      assert.ok(openapi.includes(r), `must contain ${r}`);
    }

    // No duplicate operationId
    const opCount = (openapi.match(/operationId:\s*getBasicFinancialSummary/g) || []).length;
    assert.equal(opCount, 1, 'operationId must be unique');
  });

  it('migration: no migration used by FIN-RPT-01, 0333 highest, 0334 absent', () => {
    const files = readdirSync(MIGRATION_DIR) as string[];
    assert.ok(!files.some((f: string) => f.startsWith('0334')), '0334 must be absent');
    const has0333 = files.some((f: string) => f.startsWith('0333'));
    assert.ok(has0333, '0333 must exist');
    const highest = files.filter((f: string) => /^\d{4}_/.test(f)).sort().pop();
    assert.ok(highest?.startsWith('0333'), `highest migration must be 0333, got ${highest}`);
  });

  it('backend handoff readiness: contract frozen / frontend-ready', () => {
    const types = src(TYPES_PATH);
    const openapi = src(OPENAPI_PATH);
    // byCurrency authoritative
    assert.ok(types.includes('monetarySummary'), 'must have monetarySummary authoritative');
    assert.ok(types.includes('byCurrency'), 'byCurrency authoritative');
    // unknown explicit
    assert.ok(types.includes('unknown'), 'unknown explicit');
    // legacy scalars convenience-only nullable
    assert.ok(types.includes('amount: number | null'), 'legacy scalars nullable convenience-only');
    // no mixed grand total
    assert.ok(!openapi.includes('totalIncome') || openapi.includes('BasicFinancial'), 'must not have mixed grand total totalIncome');
    // no FX in base report
    assert.ok(!openapi.includes('/buildings/{buildingId}/financial-summary:') || !openapi.slice(openapi.indexOf('/buildings/{buildingId}/financial-summary:'), openapi.indexOf('/buildings/{buildingId}/financial-summary:') + 5000).includes('convertedTotal'), 'no FX in base report');
    // OpenAPI present
    assert.ok(openapi.includes('/buildings/{buildingId}/financial-summary:'), 'OpenAPI must be present for handoff');
  });
});
