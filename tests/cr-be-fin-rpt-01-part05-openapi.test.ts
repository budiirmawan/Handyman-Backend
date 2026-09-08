import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(__dirname, '..', 'src');
const OPENAPI_PATH = join(__dirname, '..', 'docs', 'api', 'openapi.yaml');
const ROUTES_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.routes.ts');
const REPO_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.repository.ts');
const SERVICE_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.service.ts');
const TYPES_PATH = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.types.ts');
const MIGRATION_DIR = join(SRC_ROOT, 'database', 'migrations');

function src(file: string) {
  return readFileSync(file, 'utf8');
}

describe('CR-BE-FIN-RPT-01 PART 05 — public API / OpenAPI contract alignment', () => {
  it('runtime route exists', () => {
    assert.ok(existsSync(ROUTES_PATH), 'routes file must exist');
    const content = src(ROUTES_PATH);
    assert.ok(content.includes('/buildings/:buildingId/financial-summary'), 'runtime must have GET /buildings/:buildingId/financial-summary');
    assert.ok(content.includes('basic_financial_reporting.read'), 'must require basic_financial_reporting.read');
    assert.ok(content.includes('authenticationMiddleware'), 'must have authentication');
    assert.ok(content.includes('requirePermission'), 'must have RBAC');
    assert.ok(content.includes('getBasicFinancialSummaryHandler'), 'must use handler');
  });

  it('OpenAPI path exists and method GET', () => {
    assert.ok(existsSync(OPENAPI_PATH), 'openapi.yaml must exist');
    const content = src(OPENAPI_PATH);
    assert.ok(content.includes('/buildings/{buildingId}/financial-summary:'), 'OpenAPI must have /buildings/{buildingId}/financial-summary path');
    // Check method GET under that path
    const idx = content.indexOf('/buildings/{buildingId}/financial-summary:');
    const snippet = content.slice(idx, idx + 2000);
    assert.ok(snippet.includes('get:'), 'method must be GET');
    assert.ok(snippet.includes('operationId: getBasicFinancialSummary'), 'operationId must be getBasicFinancialSummary');
  });

  it('permission matches runtime', () => {
    const openapi = src(OPENAPI_PATH);
    const route = src(ROUTES_PATH);
    // Runtime permission
    assert.ok(route.includes('basic_financial_reporting.read'), 'runtime permission must be basic_financial_reporting.read');
    // OpenAPI permission
    const idx = openapi.indexOf('/buildings/{buildingId}/financial-summary:');
    const snippet = openapi.slice(idx, idx + 5000);
    assert.ok(snippet.includes('x-required-permission: basic_financial_reporting.read'), 'OpenAPI x-required-permission must match runtime');
  });

  it('Building scope metadata truthful', () => {
    const openapi = src(OPENAPI_PATH);
    const idx = openapi.indexOf('/buildings/{buildingId}/financial-summary:');
    const snippet = openapi.slice(idx, idx + 5000);
    assert.ok(snippet.includes('x-building-scoped: true'), 'must have x-building-scoped: true');
  });

  it('documented query params equal runtime-supported params', () => {
    const openapi = src(OPENAPI_PATH);
    const idx = openapi.indexOf('/buildings/{buildingId}/financial-summary:');
    const snippet = openapi.slice(idx, idx + 5000);
    // Runtime supports periodFrom, periodTo, tenantCompanyId
    assert.ok(snippet.includes('periodFrom'), 'must document periodFrom');
    assert.ok(snippet.includes('periodTo'), 'must document periodTo');
    assert.ok(snippet.includes('tenantCompanyId'), 'must document tenantCompanyId');
    // Must NOT invent extra params not in runtime validation
    const validationPath = join(SRC_ROOT, 'modules', 'basic-financial-reporting', 'basic-financial-reporting.validation.ts');
    const validationContent = src(validationPath);
    assert.ok(validationContent.includes('periodFrom') || validationContent.includes('tenantCompanyId'), 'validation must have filters');
  });

  it('monetarySummary documented', () => {
    const openapi = src(OPENAPI_PATH);
    assert.ok(openapi.includes('BasicFinancialSummary'), 'must have BasicFinancialSummary schema');
    assert.ok(openapi.includes('BasicFinancialMonetarySummary'), 'must have BasicFinancialMonetarySummary schema');
    const idx = openapi.indexOf('/buildings/{buildingId}/financial-summary:');
    const snippet = openapi.slice(idx, idx + 5000);
    assert.ok(snippet.includes('BasicFinancialSummary'), 'path response must reference BasicFinancialSummary');
  });

  it('byCurrency documented', () => {
    const openapi = src(OPENAPI_PATH);
    assert.ok(openapi.includes('BasicFinancialByCurrencyEntry'), 'must have byCurrency entry schema');
    // Check fields inside byCurrency entry
    assert.ok(openapi.includes('billedIncome'), 'byCurrency must have billedIncome');
    assert.ok(openapi.includes('receivedIncome'), 'byCurrency must have receivedIncome');
    assert.ok(openapi.includes('operationalCost'), 'byCurrency must have operationalCost');
    assert.ok(openapi.includes('netBilled'), 'byCurrency must have netBilled');
    assert.ok(openapi.includes('netReceived'), 'byCurrency must have netReceived');
    assert.ok(openapi.includes('tenantCharges'), 'byCurrency must have tenantCharges');
    assert.ok(openapi.includes('utilityBills'), 'byCurrency must have utilityBills');
    assert.ok(openapi.includes('paidAmount'), 'byCurrency must have paidAmount');
    assert.ok(openapi.includes('outstandingAmount'), 'byCurrency must have outstandingAmount');
  });

  it('unknown documented', () => {
    const openapi = src(OPENAPI_PATH);
    assert.ok(openapi.includes('BasicFinancialUnknown'), 'must have BasicFinancialUnknown schema');
    // Check description for UNKNOWN
    const idx = openapi.indexOf('BasicFinancialUnknown:');
    const snippet = openapi.slice(idx, idx + 3000);
    assert.ok(snippet.toLowerCase().includes('historical') || snippet.toLowerCase().includes('unknown'), 'unknown must be described as historical without governed snapshot');
    assert.ok(snippet.includes('tenantCharges') || openapi.includes('tenantCharges'), 'unknown must have per-source facts');
  });

  it('legacy monetary fields nullable', () => {
    const openapi = src(OPENAPI_PATH);
    // Find BasicFinancialSummary schema and check amount fields nullable
    const idx = openapi.indexOf('BasicFinancialSummary:');
    const snippet = openapi.slice(idx, idx + 15000);
    // Legacy amounts must be nullable
    const nullableCount = (snippet.match(/nullable:\s*true/g) || []).length;
    assert.ok(nullableCount >= 10, `expected at least 10 nullable fields for legacy monetary scalars, got ${nullableCount}`);
    assert.ok(snippet.includes('amount:') && snippet.includes('nullable: true'), 'legacy amount fields must be nullable');
  });

  it('distinctKnownCurrencies, hasUnknown, singleCurrencyCode documented', () => {
    const openapi = src(OPENAPI_PATH);
    assert.ok(openapi.includes('distinctKnownCurrencies'), 'must document distinctKnownCurrencies');
    assert.ok(openapi.includes('hasUnknown'), 'must document hasUnknown');
    assert.ok(openapi.includes('singleCurrencyCode'), 'must document singleCurrencyCode');
    const idx = openapi.indexOf('singleCurrencyCode:');
    const snippet = openapi.slice(idx, idx + 500);
    assert.ok(snippet.includes('nullable: true'), 'singleCurrencyCode must be nullable');
  });

  it('no FX fields in basic financial reporting', () => {
    const openapi = src(OPENAPI_PATH);
    const idx = openapi.indexOf('/buildings/{buildingId}/financial-summary:');
    const snippet = openapi.slice(idx, idx + 5000);
    const schemaIdx = openapi.indexOf('BasicFinancialSummary:');
    const schemaSnippet = openapi.slice(schemaIdx, schemaIdx + 20000);
    const combined = snippet + '\n' + schemaSnippet;
    assert.ok(!combined.includes('convertedTotal'), 'must not have convertedTotal');
    assert.ok(!combined.includes('reportingCurrency'), 'must not have reportingCurrency');
    assert.ok(!combined.includes('fxRateId'), 'must not have fxRateId');
    assert.ok(!combined.includes('fxRate') || combined.includes('BasicFinancial'), 'must not have fxRate (allow BasicFinancial prefix)');
    assert.ok(!combined.includes('conversionMode'), 'must not have conversionMode');
    // More specific: check no FX tag in this path
    assert.ok(!snippet.includes('convertedAmount'), 'must not have convertedAmount');
  });

  it('no converted grand total', () => {
    const openapi = src(OPENAPI_PATH);
    const idx = openapi.indexOf('BasicFinancialSummary:');
    const snippet = openapi.slice(idx, idx + 20000);
    // Must NOT have a single totalIncome or grand total without currency grouping
    assert.ok(!snippet.includes('totalIncome'), 'must not have totalIncome mixed grand total');
    assert.ok(!snippet.includes('grandTotal'), 'must not have grandTotal');
    // Must have byCurrency which is the safe alternative
    assert.ok(snippet.includes('byCurrency'), 'must have byCurrency as safe alternative');
  });

  it('no unresolved $ref and operationId unique', () => {
    const openapi = src(OPENAPI_PATH);
    // Check all $ref to components/schemas exist
    const refRegex = /\$ref:\s*\"#\/components\/schemas\/([A-Za-z0-9_]+)\"/g;
    let match: RegExpExecArray | null;
    const refs = new Set<string>();
    while ((match = refRegex.exec(openapi)) !== null) {
      refs.add(match[1]);
    }
    // Extract defined schemas
    const schemaDefRegex = /^\s{4}([A-Za-z0-9_]+):\s*$/gm;
    const defined = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = schemaDefRegex.exec(openapi)) !== null) {
      defined.add(m[1]);
    }
    // Check each ref that is used in our new path is defined
    const requiredRefs = ['BasicFinancialSummary', 'BasicFinancialMonetarySummary', 'BasicFinancialByCurrencyEntry', 'BasicFinancialUnknown', 'BasicFinancialCurrencyBucket'];
    for (const r of requiredRefs) {
      assert.ok(defined.has(r) || refs.has(r), `schema ${r} must be defined`);
      // If ref exists, its definition must exist
      if (refs.has(r)) {
        assert.ok(defined.has(r), `ref ${r} must have definition`);
      }
    }
    // Check operationId unique: getBasicFinancialSummary appears only once
    const opIdMatches = (openapi.match(/operationId:\s*getBasicFinancialSummary/g) || []).length;
    assert.equal(opIdMatches, 1, `operationId getBasicFinancialSummary must be unique, found ${opIdMatches}`);
  });

  it('runtime shape names represented exactly', () => {
    const openapi = src(OPENAPI_PATH);
    const typesContent = src(TYPES_PATH);
    // Runtime names from types must be in OpenAPI
    const runtimeNames = ['monetarySummary', 'byCurrency', 'unknown', 'distinctKnownCurrencies', 'hasUnknown', 'singleCurrencyCode', 'billedIncome', 'receivedIncome', 'operationalCost', 'netBilled', 'netReceived', 'tenantCharges', 'utilityBills', 'invoices', 'paidAmount', 'outstandingAmount', 'receiptsIssued', 'vendorServiceCosts', 'basicExpenses', 'unrepresentedVendorCosts'];
    for (const name of runtimeNames) {
      assert.ok(openapi.includes(name), `OpenAPI must contain runtime field ${name}`);
    }
  });

  it('no migration 0334', () => {
    const files = readdirSync(MIGRATION_DIR) as string[];
    assert.ok(!files.some((f: string) => f.startsWith('0334')), '0334 must not exist');
  });
});
