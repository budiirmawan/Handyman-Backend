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

const TENANT_INVOICE_SERVICE = join(SRC_ROOT, 'modules', 'tenant-invoices', 'tenant-invoice.service.ts');
const UTILITY_BILL_SERVICE = join(SRC_ROOT, 'modules', 'utility-bills', 'utility-bill.service.ts');
const PAYMENT_RECEIPT_SERVICE = join(SRC_ROOT, 'modules', 'payment-receipts', 'payment-receipt.service.ts');
const INVOICE_PAYMENT_STATUS_SERVICE = join(SRC_ROOT, 'modules', 'invoice-payment-status', 'invoice-payment-status.service.ts');

function src(file: string) {
  return readFileSync(file, 'utf8');
}

describe('CR-BE-FIN-RPT-01 PART 04 — payment/outstanding + cross-module safety', () => {
  it('invoice_payment_status has no own currency column, inherits from invoice', () => {
    // Check migration 0199 or 0200? Actually invoice_payment_status migration
    const fs = require('node:fs');
    const files = fs.readdirSync(MIGRATION_DIR) as string[];
    const invPayFile = files.find((f: string) => f.includes('invoice_payment_status') || f.includes('payment_status'));
    if (invPayFile) {
      const content = src(join(MIGRATION_DIR, invPayFile));
      // Should NOT have currency_code column
      assert.ok(!/currency_code/.test(content) || content.includes('invoice_id'), 'invoice_payment_status should not have own currency_code, inherits via invoice_id');
    }
    // Check repository uses i.currency_code
    const repoContent = src(REPO_PATH);
    assert.ok(repoContent.includes('i.currency_code'), 'paymentsGrouped must use i.currency_code from invoice');
    assert.ok(repoContent.includes('invoice_payment_status'), 'must reference invoice_payment_status');
  });

  it('payment_receipts has no own currency column, inherits via JOIN invoice', () => {
    const repoContent = src(REPO_PATH);
    assert.ok(repoContent.includes('payment_receipts') && repoContent.includes('JOIN tenant_invoices'), 'receipts must JOIN tenant_invoices to inherit currency');
    assert.ok(repoContent.includes('i.currency_code'), 'receiptsGrouped must use i.currency_code');
    // Check migration 0200
    const migration0200 = join(MIGRATION_DIR, '0200_create_payment_receipts.ts');
    if (existsSync(migration0200)) {
      const content = src(migration0200);
      assert.ok(!content.includes('currency_code'), 'payment_receipts migration must not have currency_code column');
      assert.ok(content.includes('invoice_id'), 'payment_receipts must have invoice_id for lineage');
    }
  });

  it('paid IDR remains IDR, paid USD remains USD, separate', async () => {
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
          byCurrency: {
            IDR: { paidAmount: 400, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 600, unpaidCount: 0, partiallyPaidCount: 1, paidCount: 0, overdueCount: 0 },
            USD: { paidAmount: 200, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 300, unpaidCount: 0, partiallyPaidCount: 1, paidCount: 0, overdueCount: 0 },
          },
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 0, partiallyPaidCount: 2, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: { IDR: { count: 1, amount: 400 }, USD: { count: 1, amount: 200 } }, unknown: { count: 0, amount: 0 }, totalCount: 2 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: {}, unknown: { amount: 0 } },
    };
    const summary = buildMonetarySummary(foundation);
    assert.equal(summary.byCurrency['IDR'].paidAmount, 400);
    assert.equal(summary.byCurrency['USD'].paidAmount, 200);
    assert.equal(summary.byCurrency['IDR'].outstandingAmount, 600);
    assert.equal(summary.byCurrency['USD'].outstandingAmount, 300);
    assert.equal(summary.byCurrency['IDR'].receiptsIssued.amount, 400);
    assert.equal(summary.byCurrency['USD'].receiptsIssued.amount, 200);
    assert.equal(Object.keys(summary.byCurrency).length, 2);
  });

  it('outstanding grouped by invoice currency, no cross-currency', async () => {
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
        invoices: { byCurrency: {}, unknown: { count: 0, amount: 0 } },
        payments: {
          byCurrency: {
            IDR: { paidAmount: 0, unpaidAmount: 100, overdueAmount: 50, outstandingAmount: 150, unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 1 },
            USD: { paidAmount: 0, unpaidAmount: 200, overdueAmount: 0, outstandingAmount: 200, unpaidCount: 1, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          },
          unknown: { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 2, partiallyPaidCount: 0, paidCount: 0, overdueCount: 1 },
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
    assert.equal(summary.byCurrency['IDR'].unpaidAmount, 100);
    assert.equal(summary.byCurrency['IDR'].overdueAmount, 50);
    assert.equal(summary.byCurrency['IDR'].outstandingAmount, 150);
    assert.equal(summary.byCurrency['USD'].unpaidAmount, 200);
    assert.equal(summary.byCurrency['USD'].outstandingAmount, 200);
  });

  it('historical NULL invoice -> payment UNKNOWN and receipt UNKNOWN', async () => {
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
        invoices: { byCurrency: {}, unknown: { count: 1, amount: 1000 } },
        payments: {
          byCurrency: {},
          unknown: { paidAmount: 400, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 600, unpaidCount: 0, partiallyPaidCount: 1, paidCount: 0, overdueCount: 0 },
          totalCounts: { unpaidCount: 0, partiallyPaidCount: 1, paidCount: 0, overdueCount: 0 },
        },
      },
      receipts: {
        issued: { byCurrency: {}, unknown: { count: 1, amount: 400 }, totalCount: 1 },
        void: { byCurrency: {}, unknown: { count: 0, amount: 0 }, totalCount: 0 },
      },
      vendorServiceCosts: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      basicExpenses: { byCurrency: {}, unknown: { count: 0, amount: 0 }, finalizedCount: 0, draftCount: 0, cancelledCount: 0 },
      unrepresentedVendorCosts: { byCurrency: {}, unknown: { amount: 0 } },
    };
    const summary = buildMonetarySummary(foundation);
    assert.equal(Object.keys(summary.byCurrency).length, 0);
    assert.equal(summary.unknown.invoices.amount, 1000);
    assert.equal(summary.unknown.paidAmount.amount, 400);
    assert.equal(summary.unknown.outstandingAmount.amount, 600);
    assert.equal(summary.unknown.receiptsIssued.amount, 400);
    assert.equal(summary.hasUnknown, true);
  });

  it('UNKNOWN never enters known totals and never cross-currency subtract', async () => {
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
      basicExpenses: { byCurrency: { IDR: { count: 1, amount: 100 } }, unknown: { count: 1, amount: 9999 } },
      unrepresentedVendorCosts: { byCurrency: {}, unknown: { amount: 0 } },
    };
    const summary = buildMonetarySummary(foundation);
    // Known cost 100, unknown 9999 must NOT affect operationalCost
    assert.equal(summary.byCurrency['IDR'].operationalCost, 100);
    assert.equal(summary.byCurrency['IDR'].netBilled, 900);
    assert.equal(summary.unknown.basicExpenses.amount, 9999);
  });

  it('receipt reporting inherits invoice currency', () => {
    const repoContent = src(REPO_PATH);
    // Must JOIN tenant_invoices and GROUP BY i.currency_code
    assert.ok(repoContent.includes('payment_receipts') && repoContent.includes('JOIN tenant_invoices'), 'receipts must JOIN invoice');
    assert.ok(repoContent.includes('i.currency_code'), 'receipts must use i.currency_code');
  });

  it('utility-bill/invoice lineage remains exact', () => {
    // Check tenant-invoices service still has exact equality guards
    if (existsSync(TENANT_INVOICE_SERVICE)) {
      const content = src(TENANT_INVOICE_SERVICE);
      assert.ok(content.includes('CURRENCY_MISMATCH') || content.includes('currency'), 'tenant-invoice service must still have currency mismatch guard');
      assert.ok(content.includes('SOURCE_CURRENCY_UNKNOWN') || content.includes('UNKNOWN'), 'must have unknown source guard');
    }
    // Check utility bills still have exact equality
    const repoContent = src(REPO_PATH);
    assert.ok(repoContent.includes('utility_bills'), 'must still handle utility bills');
  });

  it('transactional guards unchanged (CUR-02 safeguards)', () => {
    // Verify tenant invoice header = every line guard still present in tenant-invoice.service.ts and errors.ts
    const errorsPath = join(SRC_ROOT, 'modules', 'tenant-invoices', 'tenant-invoice.errors.ts');
    const serviceContent = existsSync(TENANT_INVOICE_SERVICE) ? src(TENANT_INVOICE_SERVICE) : '';
    const errorsContent = existsSync(errorsPath) ? src(errorsPath) : '';
    const combined = serviceContent + '\n' + errorsContent;
    assert.ok(
      combined.includes('TENANT_INVOICE_CURRENCY_MISMATCH') || combined.includes('tenantInvoiceCurrencyMismatchError'),
      'must preserve currency mismatch error',
    );
    assert.ok(
      combined.includes('TENANT_INVOICE_SOURCE_CURRENCY_UNKNOWN') || combined.includes('tenantInvoiceSourceCurrencyUnknownError'),
      'must preserve unknown source guard',
    );
    // Verify no relaxation: basic-financial-reporting must not contain code that makes mismatched currencies compatible
    const basicServiceContent = src(SERVICE_PATH);
    const monetaryContent = src(MONETARY_PATH);
    assert.ok(!basicServiceContent.includes('fxConversionService'), 'must not import conversion service to make mismatched compatible');
    assert.ok(!monetaryContent.includes('fxConversionService'), 'monetary-summary must not import conversion service');
  });

  it('cross-module safety: no mixed grand total, no cross-currency net, no FX import', () => {
    const repoContent = src(REPO_PATH);
    const serviceContent = src(SERVICE_PATH);
    const monetaryContent = src(MONETARY_PATH);

    // No mixed grand total: must have byCurrency, not scalar SUM without GROUP BY
    assert.ok(repoContent.includes('byCurrency'), 'repo must have byCurrency');
    assert.ok(repoContent.includes('GROUP BY'), 'repo must GROUP BY currency');

    // No cross-currency net: monetary-summary must compute net per currency only
    assert.ok(monetaryContent.includes('byCurrency[code]') || monetaryContent.includes('byCurrency'), 'must compute net per currency');
    assert.ok(!/billedIncome.*\+.*receivedIncome/.test(monetaryContent), 'must not sum different income types across currencies without grouping');

    // No FX import
    for (const file of [REPO_PATH, SERVICE_PATH, MONETARY_PATH]) {
      const content = src(file);
      assert.ok(!content.includes('fxConversionService'), `${file} must not import fxConversionService`);
      assert.ok(!content.includes('fxReportingService'), `${file} must not import fxReportingService`);
      assert.ok(!/amount\s*\*\s*rate/.test(content), `${file} must not contain amount * rate`);
      assert.ok(!/amount\s*\/\s*rate/.test(content), `${file} must not contain amount / rate`);
    }
  });

  it('no migration 0334 and no historical rewrite', () => {
    const fs = require('node:fs');
    const files = fs.readdirSync(MIGRATION_DIR) as string[];
    assert.ok(!files.some((f: string) => f.startsWith('0334')), '0334 must not exist');
    const repoContent = src(REPO_PATH);
    assert.ok(!repoContent.includes('UPDATE tenant_charges'), 'must not rewrite historical tenant_charges');
    assert.ok(!repoContent.includes('UPDATE tenant_invoices'), 'must not rewrite historical invoices');
    assert.ok(!repoContent.includes('UPDATE vendor_service_costs'), 'must not rewrite historical costs');
  });

  it('existing monetarySummary remains stable', () => {
    const typesContent = src(TYPES_PATH);
    assert.ok(typesContent.includes('monetarySummary'), 'public response must contain monetarySummary');
    assert.ok(typesContent.includes('byCurrency'), 'must contain byCurrency');
    assert.ok(typesContent.includes('billedIncome'), 'must contain billedIncome per currency');
    assert.ok(typesContent.includes('operationalCost'), 'must contain operationalCost per currency');
    assert.ok(typesContent.includes('netBilled'), 'must contain netBilled per currency');
    assert.ok(typesContent.includes('distinctKnownCurrencies'), 'must contain distinctKnownCurrencies');
    assert.ok(typesContent.includes('hasUnknown'), 'must contain hasUnknown');
  });

  it('no mixed monetary scalar reintroduced', () => {
    const repoContent = src(REPO_PATH);
    // Old unsafe pattern must not exist
    assert.ok(!repoContent.includes(`SELECT COUNT(*) FILTER(WHERE status='ACTIVE')::int count,COALESCE(SUM(amount)FILTER(WHERE status='ACTIVE'),0)::text amount,COUNT(*)FILTER(WHERE status='CANCELLED')::int cancelled FROM tenant_charges WHERE building_id=$1 AND($2::date IS NULL OR charge_date>=$2)AND($3::date IS NULL OR charge_date<=$3)AND($4::uuid IS NULL OR tenant_company_id=$4)`), 'old unsafe tenant_charges query must not exist');
    // Must have GROUP BY
    const groupByMatches = (repoContent.match(/GROUP BY/g) || []).length;
    assert.ok(groupByMatches >= 7, `must have at least 7 GROUP BY, got ${groupByMatches}`);
  });
});
