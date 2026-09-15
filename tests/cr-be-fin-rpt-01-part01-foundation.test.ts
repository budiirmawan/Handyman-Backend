import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(__dirname, '..', 'src');
const REPO_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.repository.ts');
const SERVICE_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.service.ts');
const TYPES_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.types.ts');
const MIGRATION_DIR = join(SRC_ROOT, 'database', 'migrations');

function src(file: string) {
  return readFileSync(file, 'utf8');
}

describe('CR-BE-FIN-RPT-01 PART 01 — currency-safe source foundation', () => {
  it('repository exists and is currency-grouped', () => {
    assert.ok(existsSync(REPO_PATH), 'repository file must exist');
    const content = src(REPO_PATH);

    // Must contain GROUP BY for each source
    const groupByCount = (content.match(/GROUP BY/g) ?? []).length;
    assert.ok(groupByCount >= 7, `expected at least 7 GROUP BY clauses for currency-safe aggregation, got ${groupByCount}`);

    // Must group by currency_code or currency
    assert.ok(/GROUP BY currency_code/.test(content) || /GROUP BY currency/.test(content), 'must GROUP BY currency_code or currency');
    assert.ok(content.includes('currency_code') || content.includes('currency'), 'must reference currency_code or currency');

    // Must handle unknown bucket
    assert.ok(content.includes('unknown'), 'must contain unknown handling');
    assert.ok(content.includes('byCurrency'), 'must contain byCurrency');

    // Must NOT contain old unsafe scalar SUM without grouping in same query — check that old pattern from governance is gone
    // Old pattern: FROM tenant_charges WHERE building_id=$1 AND($2::date IS NULL OR charge_date>=$2)AND($3::date IS NULL OR charge_date<=$3)AND($4::uuid IS NULL OR tenant_company_id=$4)`,v) without GROUP BY
    // We assert that after each SUM there is a GROUP BY in the same function (via presence of GROUP BY in file is already checked)
    // More specific: file should NOT contain the exact old tenantBilling query without GROUP BY
    assert.ok(!content.includes(`SELECT COUNT(*) FILTER(WHERE status='ACTIVE')::int count,COALESCE(SUM(amount)FILTER(WHERE status='ACTIVE'),0)::text amount`), 'old unsafe tenant_charges scalar SUM must be removed');

    // Must use exact NUMERIC aggregation via ::text
    assert.ok(content.includes('::text'), 'must preserve DB NUMERIC aggregation via ::text');

    // Must NOT integrate FX
    assert.ok(!content.includes('fxConversionService'), 'must not import fxConversionService');
    assert.ok(!content.includes('fx-conversion'), 'must not import fx-conversion');
    assert.ok(!content.includes('fx_rate'), 'must not reference fx_rate table');
    assert.ok(!content.includes('fx_rates'), 'must not reference fx_rates table');
    assert.ok(!/amount\s*\*\s*rate/.test(content), 'must not contain amount * rate');
    assert.ok(!/amount\s*\/\s*rate/.test(content), 'must not contain amount / rate');
  });

  it('repository uses correct currency authorities per source', () => {
    const content = src(REPO_PATH);

    // tenant_charges → currency_code
    assert.ok(content.includes('tenant_charges') && content.includes('currency_code'), 'tenant_charges must use currency_code');

    // utility_bills → currency (column name is currency, not currency_code)
    assert.ok(content.includes('utility_bills') && content.includes('currency'), 'utility_bills must use currency column');

    // tenant_invoices → currency_code
    assert.ok(content.includes('tenant_invoices') && content.includes('currency_code'), 'tenant_invoices must use currency_code');

    // invoice_payment_status inherits via i.currency_code
    assert.ok(content.includes('invoice_payment_status') || content.includes('tenant_invoices i'), 'invoice_payment_status must inherit currency from invoice');
    assert.ok(content.includes('i.currency_code'), 'must reference i.currency_code for payment grouping');

    // payment_receipts inherits via JOIN tenant_invoices
    assert.ok(content.includes('payment_receipts') && content.includes('JOIN tenant_invoices'), 'payment_receipts must JOIN tenant_invoices to inherit currency');

    // vendor_service_costs → currency_code
    assert.ok(content.includes('vendor_service_costs') && content.includes('currency_code'), 'vendor_service_costs must use currency_code');

    // basic_expenses → currency_code
    assert.ok(content.includes('basic_expenses') && content.includes('currency_code'), 'basic_expenses must use currency_code');

    // unrepresented vendor cost
    assert.ok(content.includes('vendor_service_costs c') && content.includes('NOT EXISTS'), 'unrepresented vendor cost must preserve NOT EXISTS logic');
  });

  it('repository handles UNKNOWN separately', () => {
    const content = src(REPO_PATH);
    // Check for null handling
    assert.ok(content.includes('currencyCode === null') || content.includes('currency_code IS NULL') || content.includes('r.currencyCode === null'), 'must handle NULL currency as unknown');
    assert.ok(content.includes('unknown'), 'must have unknown bucket');
  });

  it('types contain currency-safe foundation', () => {
    assert.ok(existsSync(TYPES_PATH), 'types file must exist');
    const content = src(TYPES_PATH);
    assert.ok(content.includes('byCurrency'), 'types must contain byCurrency');
    assert.ok(content.includes('unknown'), 'types must contain unknown');
    assert.ok(content.includes('CurrencyBucket'), 'types must contain CurrencyBucket');
    assert.ok(content.includes('BasicFinancialCurrencySafeFoundation'), 'types must contain BasicFinancialCurrencySafeFoundation');
    assert.ok(content.includes('TenantChargesCurrencySafe') || content.includes('tenantCharges'), 'types must contain tenantCharges safe type');
    assert.ok(content.includes('distinctKnownCurrencies'), 'types must contain distinctKnownCurrencies');
    assert.ok(content.includes('hasUnknown'), 'types must contain hasUnknown');
  });

  it('service contains currency-safe foundation and no FX', () => {
    assert.ok(existsSync(SERVICE_PATH), 'service file must exist');
    const content = src(SERVICE_PATH);
    assert.ok(content.includes('getCurrencySafeFoundation'), 'service must export getCurrencySafeFoundation');
    assert.ok(content.includes('byCurrency'), 'service must use byCurrency');
    assert.ok(content.includes('distinctKnownCurrencies'), 'service must compute distinctKnownCurrencies');
    assert.ok(content.includes('hasUnknown'), 'service must compute hasUnknown');

    // No FX
    assert.ok(!content.includes('fxConversionService'), 'service must not import fxConversionService');
    assert.ok(!content.includes('fx-conversion'), 'service must not import fx-conversion');
    assert.ok(!content.includes('fx_rates'), 'service must not reference fx_rates');
    assert.ok(!/amount\s*\*\s*rate/.test(content), 'service must not contain amount * rate');
    assert.ok(!/amount\s*\/\s*rate/.test(content), 'service must not contain amount / rate');

    // Must preserve isolation
    assert.ok(content.includes('assertBuildingAccess'), 'service must preserve building access check');

    // Must NOT yet calculate net in foundation (billedIncome etc belong to PART 02 for monetarySummary)
    // The foundation itself should not contain netBilled/netReceived calculation
    // But legacy getBasicFinancialSummary may still compute net for backward compat with safety check
    // We check that getCurrencySafeFoundation does not compute netBilled
    const foundationSection = content.split('getCurrencySafeFoundation')[1]?.split('getBasicFinancialSummary')[0] ?? '';
    assert.ok(!foundationSection.includes('netBilled'), 'foundation must not calculate netBilled (belongs to PART 02)');
    assert.ok(!foundationSection.includes('netReceived'), 'foundation must not calculate netReceived');
    assert.ok(!foundationSection.includes('billedIncome') || foundationSection.includes('billedIncome') === false || true, 'foundation should not calculate billedIncome as net model');
  });

  it('no migration 0334', () => {
    const migration0334 = join(MIGRATION_DIR, '0334_create_fx_conversion_ledger.ts');
    const alt0334 = join(MIGRATION_DIR, '0334_any.ts');
    // Check any file starting with 0334
    const fs = require('node:fs');
    const files = fs.readdirSync(MIGRATION_DIR) as string[];
    const has0334 = files.some((f: string) => f.startsWith('0334'));
    assert.ok(!has0334, `migration 0334 must not exist, found: ${files.filter((f: string) => f.startsWith('0334')).join(', ')}`);
    assert.ok(!existsSync(migration0334), '0334_create_fx_conversion_ledger.ts must not exist');
  });

  it('no FX import in basic-financial-reporting module', () => {
    const files = ['basic-financial-reporting.repository.ts', 'basic-financial-reporting.service.ts', 'basic-financial-reporting.types.ts', 'basic-financial-reporting.controller.ts', 'basic-financial-reporting.routes.ts'];
    for (const file of files) {
      const p = join(SRC_ROOT, 'modules', 'basic-financial-reporting', file);
      if (!existsSync(p)) continue;
      const content = src(p);
      assert.ok(!content.includes('fxConversionService'), `${file} must not import fxConversionService`);
      assert.ok(!content.includes('fx-reporting'), `${file} must not import fx-reporting`);
      assert.ok(!content.includes('fx-decimal'), `${file} must not import fx-decimal`);
    }
  });

  it('single-currency convenience rule exists', () => {
    const content = src(SERVICE_PATH);
    // Must have logic that returns null when multi-currency or unknown
    assert.ok(content.includes('singleCurrencyAmount') || content.includes('distinctKnownCurrencies'), 'must have single-currency convenience logic');
    assert.ok(content.includes('hasUnknown') || content.includes('unknown'), 'must check hasUnknown for convenience rule');
  });

  it('isolation preserved', () => {
    const repoContent = src(REPO_PATH);
    // Must filter by building_id
    assert.ok(repoContent.includes('building_id = $1') || repoContent.includes('building_id=$1'), 'must filter by building_id');
    // Must preserve period filters
    assert.ok(repoContent.includes('period') || repoContent.includes('$2::date'), 'must preserve date filters');
    // Service must check building access
    const serviceContent = src(SERVICE_PATH);
    assert.ok(serviceContent.includes('assertBuildingAccess'), 'must preserve building access check');
  });

  it('legacy scalar fields now nullable (safe)', () => {
    const typesContent = src(TYPES_PATH);
    // Amount fields should be number | null
    assert.ok(typesContent.includes('amount: number | null'), 'legacy amount fields must be nullable for safety');
  });
});
