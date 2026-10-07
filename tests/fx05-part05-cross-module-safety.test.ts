import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

import { fxConversionService, type FxRateGateway } from '../src/modules/fx-rates/fx-conversion.service';
import { fxReportingService } from '../src/modules/fx-rates/fx-reporting.service';
import { FX_RATE_EVENT_TYPES, FX_RATE_SOURCES } from '../src/modules/fx-rates/fx-rate.types';
import {
  FOUNDATION_PERMISSIONS,
  UNASSIGNED_BY_DEFAULT_PERMISSION_CODES,
} from '../src/database/seeds/foundation-access.seed';
import type { ClientFxPolicy, FxRate } from '../src/modules/fx-rates/fx-rate.types';

/**
 * CR-BE-FX-01 PART 05 — cross-module FX safety and audit boundary.
 *
 * This is the consolidated safety suite governance §7 rule 1 assigns to PART 05.
 * It proves FX remains a reporting/read-side authority that cannot silently alter
 * transactional eligibility, matching, approval, actualization or lifecycle
 * decisions anywhere else in the repository.
 *
 * Everything here is dependency-free and executes in any environment.
 */

const SRC = resolve('src');
const FX_PATH = resolve('src/modules/fx-rates');
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

/** Drops comments so negative assertions inspect CODE, not explanatory prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .map((line) => line.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

function read(relative: string): string {
  return readFileSync(resolve(SRC, 'modules', relative), 'utf8');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every FX symbol a consumer could reach. */
/** Every way a consumer could reach the FX authority, including its module path. */
const FX_SYMBOLS =
  /fxConversionService|fxReportingService|fx-conversion|fx-reporting|fx-decimal|fx-rates\/|fxRateRepository|fxRateLifecycleService|clientFxPolicyService|clientFxPolicyRepository|currencyMasterRepository|clientCurrencyAllowanceRepository|databaseFxRateGateway/;

describe('CR-BE-FX-01 PART 05 — §1 FX is not wired into any transactional authority', () => {
  const transactional = [
    'rfqs',
    'vendor-quotations',
    'rfq-comparisons',
    'rfq-recommendations',
    'rfq-po-conversions',
    'purchase-orders',
    'purchase-requests',
    'price-catalog-entries',
    'vendor-invoices',
    'invoice-payment-status',
    'payment-receipts',
    'tenant-charges',
    'tenant-invoices',
    'inventory-work-order-material-usages',
    'utility-tariffs',
    'utility-calculations',
    'utility-bills',
    'vendor-service-costs',
    'basic-expenses',
  ];

  it('scans a substantial, real set of modules', () => {
    for (const m of transactional) {
      assert.ok(existsSync(resolve(SRC, 'modules', m)), `${m} must exist to be scanned`);
    }
  });

  it('imports no FX into RFQ, quotation, comparison, award, PO or price catalog', () => {
    for (const m of transactional.slice(0, 8)) {
      for (const file of walk(resolve(SRC, 'modules', m))) {
        assert.doesNotMatch(readFileSync(file, 'utf8'), FX_SYMBOLS, `${file} must not import FX`);
      }
    }
  });

  it('imports no FX into invoices, payments, tenant billing or utility lineage', () => {
    for (const m of transactional.slice(8)) {
      for (const file of walk(resolve(SRC, 'modules', m))) {
        assert.doesNotMatch(readFileSync(file, 'utf8'), FX_SYMBOLS, `${file} must not import FX`);
      }
    }
  });

  it('imports no FX into any operational control surface', () => {
    for (const file of walk(resolve(SRC, 'modules/operational-finance'))) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), FX_SYMBOLS, `${file} must not import FX`);
    }
  });

  it('confirms FX exists in exactly the sanctioned files', () => {
    const consumers = walk(SRC)
      .filter((file) => FX_SYMBOLS.test(readFileSync(file, 'utf8')))
      .map((file) => file.replace(`${SRC}${sep}`, ''))
      .sort();
    // The authority itself, the PART 04 adapter, and the router registration.
    const outsideAuthority = consumers.filter((f) => !f.startsWith(`modules${sep}fx-rates${sep}`));
    assert.deepEqual(outsideAuthority, [
      `modules${sep}currency-reporting${sep}reporting-currency-read-model.ts`,
      `routes${sep}index.ts`,
    ]);
  });
});

describe('CR-BE-FX-01 PART 05 — §2 exact-currency guards remain authoritative', () => {
  it('USD RFQ vs IDR quotation still fails', () => {
    const body = stripComments(read('vendor-quotations/vendor-quotation.service.ts'));
    assert.match(body, /currency !== rfq\.currency/);
    assert.match(body, /vendorQuotationCurrencyMismatchError/);
  });

  it('USD quotation vs RFQ comparison still fails', () => {
    const body = stripComments(read('rfq-comparisons/rfq-comparison.service.ts'));
    assert.match(body, /selected\.currency !== rfq\.currency/);
    assert.match(body, /rfqComparisonCurrencyInvalidError/);
  });

  it('USD award vs IDR PO still fails', () => {
    const body = stripComments(read('rfq-po-conversions/rfq-po-conversion.service.ts'));
    assert.match(body, /quotation\.currency !== rfq\.currency/);
  });

  it('USD vendor invoice vs IDR PO still fails', () => {
    const body = stripComments(read('vendor-invoices/vendor-invoice.service.ts'));
    assert.match(body, /purchaseOrder\.currency !== invoice\.currency/);
    assert.match(body, /CURRENCY_MISMATCH/);
  });

  it('USD budget vs IDR commitment still fails', () => {
    const body = stripComments(read('operational-finance/operational-commitment.service.ts'));
    assert.match(body, /input\.currency !== locked\.currency/);
    assert.match(body, /operationalCommitmentCurrencyMismatchError/);
  });

  it('USD source vs IDR budget binding still fails', () => {
    const body = stripComments(read('operational-finance/operational-finance-binding.service.ts'));
    assert.match(body, /operationalBudgetSourceCurrencyMismatchError/);
    const aggregation = stripComments(read('operational-finance/operational-finance-aggregation.service.ts'));
    assert.match(aggregation, /SOURCE_CURRENCY_MISMATCH/);
  });

  it('USD actualization vs IDR commitment still fails (vendor and material)', () => {
    const vendor = stripComments(read('operational-finance/operational-commitment-vendor.service.ts'));
    assert.match(vendor, /outcome: 'CURRENCY_MISMATCH'/);
    const material = stripComments(read('operational-finance/operational-commitment-material.service.ts'));
    assert.match(material, /operationalCommitmentCurrencyMismatchError/);
    assert.match(material, /outcome: 'CURRENCY_MISMATCH'/);
  });

  it('USD tenant invoice vs IDR line still fails', () => {
    const body = stripComments(read('tenant-invoices/tenant-invoice.service.ts'));
    assert.match(body, /tenantInvoiceCurrencyMismatchError/);
    assert.match(body, /tenantInvoiceSourceCurrencyUnknownError/);
  });

  it('price catalog lookup stays exact-currency', () => {
    const body = stripComments(read('price-catalog-entries/price-catalog-lookup.service.ts'));
    assert.match(body, /CURRENCY_INCOMPATIBLE/);
  });

  it('none of these guards consults FX', () => {
    for (const file of [
      'vendor-quotations/vendor-quotation.service.ts',
      'rfq-comparisons/rfq-comparison.service.ts',
      'rfq-po-conversions/rfq-po-conversion.service.ts',
      'vendor-invoices/vendor-invoice.service.ts',
      'operational-finance/operational-commitment.service.ts',
      'operational-finance/operational-finance-binding.service.ts',
      'operational-finance/operational-commitment-vendor.service.ts',
      'operational-finance/operational-commitment-material.service.ts',
      'tenant-invoices/tenant-invoice.service.ts',
      'price-catalog-entries/price-catalog-lookup.service.ts',
    ]) {
      assert.doesNotMatch(read(file), FX_SYMBOLS, `${file} must not consult FX`);
    }
  });
});

describe('CR-BE-FX-01 PART 05 — §3 exactly one conversion arithmetic authority', () => {
  it('has zero hand-rolled rate arithmetic anywhere in src/', () => {
    // Matches `operand * rateLike` / `operand / rateLike` in code only.
    //
    // Two earlier drafts of this guard were VACUOUS, and both defects are now
    // pinned by the self-test below:
    //   1. it skipped every line beginning with `import`/`export`, so a leaked
    //      `export const f = (amount, rate) => amount * rate` sailed straight past;
    //   2. the identifier group required a prefix before `rate`, so the canonical
    //      bare form `amount * rate` never matched at all.
    // The rate identifier prefix is therefore optional, and import/export lines
    // are kept. String literals (single, double and template) are blanked so an
    // import path such as './migrate' or '../auth/authenticate' cannot
    // false-positive on the substring "rate".
    const pattern = /[\w)\]]\s*[*/]\s*(?:[A-Za-z_][A-Za-z0-9_]*)?[Rr]ate\b/;
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const code = stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .map((line) =>
          line
            .replace(/'[^']*'/g, "''")
            .replace(/"[^"]*"/g, '""')
            .replace(/`[^`]*`/g, '``'),
        )
        .join('\n');
      if (pattern.test(code)) offenders.push(file.replace(`${SRC}${sep}`, ''));
    }
    assert.deepEqual(offenders, [], 'no module may perform rate arithmetic directly');
  });

  it('proves that arithmetic guard is not vacuous', () => {
    // Without this, the guard above could pass while matching nothing at all —
    // which is exactly what happened twice while writing it.
    const pattern = /[\w)\]]\s*[*/]\s*(?:[A-Za-z_][A-Za-z0-9_]*)?[Rr]ate\b/;
    const blank = (line: string) =>
      line.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
    for (const shouldMatch of [
      'const x = amount * rate;',
      'const x = amount / rate;',
      'const x = amount*rate;',
      'export const f = (amount: number, rate: number) => amount * rate;',
      'const x = amount * fxRate;',
      'const x = total / tariffRate;',
    ]) {
      assert.match(blank(shouldMatch), pattern, `must detect: ${shouldMatch}`);
    }
    for (const mustNotMatch of [
      'const x = a * b;',
      'const x = amount * 2;',
      "import { migrateUp } from './migrate';",
      "import { authenticationMiddleware } from '../auth/authenticate';",
    ]) {
      assert.doesNotMatch(blank(mustNotMatch), pattern, `must not flag: ${mustNotMatch}`);
    }
  });

  it('keeps both FX operations inside applyRate alone', () => {
    const source = readFileSync(resolve(FX_PATH, 'fx-conversion.service.ts'), 'utf8');
    const applyRateBody = source.slice(
      source.indexOf('function applyRate('),
      source.indexOf('export const fxConversionService'),
    );
    assert.equal(applyRateBody.split('multiply(').length - 1, 1);
    assert.equal(applyRateBody.split('divideHalfUp(').length - 1, 1);
    const rest = source.replace(applyRateBody, '').replace(/import[\s\S]*?from '\.\/fx-decimal';/, '');
    assert.doesNotMatch(rest, /multiply\(/);
    assert.equal(rest.split('divideHalfUp(').length - 1, 1, 'only the non-monetary staleness day count');
  });

  it('has exactly one consumer of the conversion authority', () => {
    const consumers = walk(SRC)
      .filter((file) => /fxConversionService/.test(stripComments(readFileSync(file, 'utf8'))))
      .filter((file) => !/fx-conversion\.(service|gateway)\.ts$/.test(file) && !/index\.ts$/.test(file))
      .map((file) => file.replace(`${SRC}${sep}`, ''));
    assert.deepEqual(consumers, [`modules${sep}fx-rates${sep}fx-reporting.service.ts`]);
  });

  it('keeps rate selection and staleness LOGIC out of every consumer', () => {
    // Mapping a PART 03 error code onto a reporting reason is not implementing
    // staleness; computing it is. So the policy field, the day constant and the
    // selection queries are what must be absent.
    const reporting = stripComments(readFileSync(resolve(FX_PATH, 'fx-reporting.service.ts'), 'utf8'));
    assert.doesNotMatch(reporting, /findAllActiveCovering|countPairCoverage|\bfx_rates\b/);
    assert.doesNotMatch(reporting, /maxStalenessDays|MS_PER_DAY|86400000/);
    const adapter = stripComments(read('currency-reporting/reporting-currency-read-model.ts'));
    assert.doesNotMatch(adapter, /\bfx_rates\b|findAllActiveCovering|maxStalenessDays/);
  });
});

describe('CR-BE-FX-01 PART 05 — §5 audit boundary has no flood path', () => {
  it('writes fx_rate_events only from the rate lifecycle service', () => {
    const writers = walk(SRC)
      .filter((file) => /fxRateEventRepository\s*\.\s*append/.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => file.replace(`${SRC}${sep}`, ''));
    assert.deepEqual(writers, [`modules${sep}fx-rates${sep}fx-rate-lifecycle.service.ts`]);
  });

  it('keeps the five-event vocabulary unchanged, with FX_RATE_APPROVED retained', () => {
    assert.deepEqual([...FX_RATE_EVENT_TYPES], [
      'FX_RATE_CREATED', 'FX_RATE_APPROVED', 'FX_RATE_REJECTED',
      'FX_RATE_SUPERSEDED', 'FX_RATE_DEACTIVATED',
    ]);
    assert.ok(FX_RATE_EVENT_TYPES.includes('FX_RATE_APPROVED'));
    assert.ok(!(FX_RATE_EVENT_TYPES as readonly string[]).includes('FX_RATE_ACTIVATED'));
    const migration = readFileSync(
      resolve(SRC, 'database/migrations/0333_create_fx_rate_authority_and_client_fx_policy.ts'),
      'utf8',
    );
    assert.match(migration, /'FX_RATE_APPROVED'/);
    assert.doesNotMatch(migration, /FX_RATE_ACTIVATED/);
  });

  it('emits Client FX Policy events only from the policy service', () => {
    const writers = walk(SRC)
      .filter((file) => /CLIENT_FX_POLICY_(SET|CHANGED)/.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => file.replace(`${SRC}${sep}`, ''));
    assert.deepEqual(writers, [`modules${sep}fx-rates${sep}client-fx-policy.service.ts`]);
    const policy = stripComments(read('fx-rates/client-fx-policy.service.ts'));
    assert.match(policy, /recordOperationalEvent/);
    assert.doesNotMatch(policy, /fxRateEventRepository/);
  });

  it('emits no audit at all from transient or reporting conversion', () => {
    for (const file of [
      'fx-rates/fx-conversion.service.ts',
      'fx-rates/fx-conversion.gateway.ts',
      'fx-rates/fx-reporting.service.ts',
      'currency-reporting/reporting-currency-read-model.ts',
    ]) {
      const body = stripComments(read(file));
      assert.doesNotMatch(body, /recordOperationalEvent/, `${file} must not audit`);
      assert.doesNotMatch(body, /fxRateEventRepository/, `${file} must not audit`);
      assert.doesNotMatch(body, /\bINSERT\b|\bUPDATE\b|\bDELETE\b/i, `${file} must not write`);
    }
  });
});

describe('CR-BE-FX-01 PART 05 — §6 materialized conversion is NOT REQUIRED', () => {
  it('adds no converted-amount column to any table', () => {
    // `fx_rate_id` is legitimately the fx_rate_events foreign key, so the §6
    // concern is narrower: no converted AMOUNT may be stored, and no transaction
    // table may gain an FX column.
    const migrations = walk(resolve(SRC, 'database/migrations'))
      .map((file) => ({ file, body: readFileSync(file, 'utf8') }))
      .filter(({ body }) => /converted_amount|reporting_amount|converted_currency|fx_rate_id/.test(body));
    assert.deepEqual(
      migrations.map((m) => m.file.split(sep).pop()),
      // The only occurrence is the audit ledger's own foreign key in 0333.
      ['0333_create_fx_rate_authority_and_client_fx_policy.ts'],
    );
    const migration = migrations[0]!.body;
    assert.match(migration, /fx_rate_id\s+UUID NOT NULL REFERENCES fx_rates \(id\)/);
    assert.doesNotMatch(migration, /converted_amount|reporting_amount|converted_currency/);
    // And no FX column was added to any monetary transaction table: the only
    // ALTER TABLE in 0333 is the window-exclusion constraint on its OWN new table.
    const altered = [...migration.matchAll(/ALTER TABLE\s+([a-z_]+)/gi)].map((m) => m[1]);
    assert.deepEqual([...new Set(altered)], ['fx_rates'], '0333 alters only its own table');
  });

  it('has no conversion ledger and no 0334', () => {
    const migrations = resolve(SRC, 'database/migrations');
    assert.equal(existsSync(resolve(migrations, '0334_create_fx_conversion_ledger.ts')), false);
    assert.equal(
      readdirSync(migrations).filter((f) => /^\d{4}_/.test(f)).sort().at(-1),
      '0333_create_fx_rate_authority_and_client_fx_policy.ts',
    );
    const anywhere = walk(SRC).filter((file) =>
      /fx_conversion_ledger|\bfx_conversions\b/.test(stripComments(readFileSync(file, 'utf8'))));
    assert.deepEqual(anywhere, []);
  });
});

describe('CR-BE-FX-01 PART 05 — §11 basic-financial-reporting stays free of FX', () => {
  // Remediation debt: CR-BE-FIN-RPT-01 — Currency-Safe Basic Financial Reporting.
  // Its SQL sums across tenant charges, utility bills, tenant invoices, payments,
  // receipts, vendor service costs and basic expenses with no currency grouping,
  // so converting on top of it would violate governance §10. FX must not be
  // integrated here until that CR lands.
  it('has no FX integration in the unsafe mixed-currency aggregate', () => {
    for (const file of walk(resolve(SRC, 'modules/basic-financial-reporting'))) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), FX_SYMBOLS, `${file} must not integrate FX`);
    }
  });

  it('is still the pre-existing mixed-currency aggregate, unchanged by FX-01', () => {
    const repo = read('basic-financial-reporting/basic-financial-reporting.repository.ts');
    assert.match(repo, /SUM\(amount\)/);
    assert.match(repo, /SUM\(bill_amount\)/);
    assert.doesNotMatch(repo, /GROUP BY\s+currency_code/i, 'still ungrouped — remediation debt, not FX-01 scope');
  });

  it('names the remediation CR in the governance record', () => {
    const doc = readFileSync(resolve('docs/CR-BE-FX-01_START_GOVERNANCE.md'), 'utf8');
    assert.match(doc, /CR-BE-FIN-RPT-01/);
  });
});

describe('CR-BE-FX-01 PART 05 — §12 export renderers stay pure consumers', () => {
  it('contains no FX logic in any renderer', () => {
    for (const file of ['csv-renderer.ts', 'xlsx-renderer.ts', 'pdf-renderer.ts']) {
      const body = readFileSync(resolve(SRC, 'modules/reporting-export', file), 'utf8');
      assert.doesNotMatch(body, FX_SYMBOLS);
      assert.doesNotMatch(body, /currency|referenceDate|fxPolicy/i, `${file} must not select rates or currencies`);
    }
  });

  it('keeps the entire export module free of FX', () => {
    for (const file of walk(resolve(SRC, 'modules/reporting-export'))) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), FX_SYMBOLS, `${file} must not integrate FX`);
    }
  });
});

describe('CR-BE-FX-01 PART 05 — §13/§15 provider and permission boundary', () => {
  it('supports MANUAL_TREASURY only, with no ingestion worker', () => {
    assert.deepEqual([...FX_RATE_SOURCES], ['MANUAL_TREASURY']);
    const migration = readFileSync(
      resolve(SRC, 'database/migrations/0333_create_fx_rate_authority_and_client_fx_policy.ts'),
      'utf8',
    );
    assert.match(migration, /source IN \('MANUAL_TREASURY'\)/);
    for (const file of walk(FX_PATH)) {
      const body = readFileSync(file, 'utf8');
      assert.doesNotMatch(body, /BANK_INDONESIA|setInterval|due-job-scheduler|fetch\(/i, `${file} must not ingest`);
    }
  });

  it('keeps fx_rate.approve unassigned by default', () => {
    assert.ok(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('fx_rate.approve'));
    assert.ok(!UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('fx_rate.manage'));
    assert.ok(!UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('fx_rate.read'));
  });

  it('registers exactly the five FX permissions and no new role', () => {
    const fx = FOUNDATION_PERMISSIONS.filter((p) => /^fx_rate\.|^client_fx_policy\./.test(p.code)).map((p) => p.code);
    assert.deepEqual(fx.sort(), [
      'client_fx_policy.manage', 'client_fx_policy.read',
      'fx_rate.approve', 'fx_rate.manage', 'fx_rate.read',
    ]);
    const seed = readFileSync(resolve(SRC, 'database/seeds/foundation-access.seed.ts'), 'utf8');
    assert.equal((seed.match(/const [A-Z_]+_ROLE = \{/g) ?? []).length, 1, 'only PLATFORM_ADMIN may exist');
  });

  it('keeps Client FX Policy Client-scoped with no Building override', () => {
    const migration = readFileSync(
      resolve(SRC, 'database/migrations/0333_create_fx_rate_authority_and_client_fx_policy.ts'),
      'utf8',
    );
    const table = migration.slice(migration.indexOf('CREATE TABLE client_fx_policies'));
    assert.match(table, /client_id\s+UUID PRIMARY KEY REFERENCES clients \(id\)/);
    assert.doesNotMatch(table, /building_id/, 'no Building override may exist');
  });
});

// ---------------------------------------------------------------------------
// Behavioural safety, driven through the real PART 03/04 authorities.
// ---------------------------------------------------------------------------

const MAKER = '22222222-2222-4222-8222-222222222222';

function rate(seed: {
  id: string; base: string; quote: string; rate: string; from: string;
  to?: string | null; status?: FxRate['status'];
}): FxRate {
  return {
    id: seed.id, baseCurrencyCode: seed.base, quoteCurrencyCode: seed.quote,
    rateType: 'REFERENCE', rate: seed.rate,
    effectiveFrom: new Date(seed.from),
    effectiveTo: seed.to === undefined ? null : seed.to === null ? null : new Date(seed.to),
    status: seed.status ?? 'ACTIVE', source: 'MANUAL_TREASURY', sourceReference: null,
    ingestedAt: null, supersedesRateId: null, supersededByRateId: null, createdByUserId: MAKER,
    approvedByUserId: null, approvedAt: null, rejectedByUserId: null, rejectedAt: null,
    rejectedReason: null, supersededByUserId: null, supersededAt: null, deactivatedByUserId: null,
    deactivatedAt: null, deactivationReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function clientPolicy(overrides: Partial<ClientFxPolicy> = {}): ClientFxPolicy {
  return {
    clientId: CLIENT_ID, fxEnabled: true, reportingCurrencyCode: 'IDR',
    permittedSources: ['MANUAL_TREASURY'], inversePermitted: false, maxStalenessDays: null,
    createdByUserId: MAKER, updatedByUserId: MAKER,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** A gateway whose rate set can be swapped, to simulate supersession. */
function mutableGateway(initial: FxRate[], policy: ClientFxPolicy | null = clientPolicy()) {
  const state = { rates: initial };
  const gateway: FxRateGateway = {
    findActiveCurrency: async (code) =>
      ({ code, decimalPrecision: code === 'IDR' || code === 'JPY' ? 0 : 2 }),
    findClientFxPolicy: async () => policy,
    findNotAllowedCurrencies: async () => [],
    findActiveCovering: async (base, quote, at) =>
      state.rates.filter(
        (r) => r.status === 'ACTIVE' && r.rateType === 'REFERENCE' &&
          r.baseCurrencyCode === base && r.quoteCurrencyCode === quote &&
          r.effectiveFrom.getTime() <= at.getTime() &&
          (r.effectiveTo === null || r.effectiveTo.getTime() > at.getTime()),
      ),
    countPairCoverage: async (base, quote) => {
      const forPair = state.rates.filter((r) => r.baseCurrencyCode === base && r.quoteCurrencyCode === quote);
      const active = forPair.filter((r) => r.status === 'ACTIVE');
      return { anyStatus: forPair.length, active: active.length, activeNotYetEffective: 0, activeExpired: forPair.length - active.length };
    },
  };
  return { gateway, setRates: (next: FxRate[]) => { state.rates = next; } };
}

describe('CR-BE-FX-01 PART 05 — §8 supersession cannot rewrite a retained result', () => {
  it('leaves a previously returned conversion untouched, and new conversions use the new rate', async () => {
    const original = rate({ id: 'rate-a', base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' });
    const { gateway, setRates } = mutableGateway([original]);

    const first = await fxConversionService.convert(
      { clientId: CLIENT_ID, sourceCurrencyCode: 'USD', targetCurrencyCode: 'IDR', amount: '100', referenceDate: '2026-03-15T00:00:00.000Z' },
      gateway,
    );
    assert.equal(first.convertedAmount, '1650000');
    assert.equal(first.provenance.fxRateId, 'rate-a');

    // Supersede: the incumbent leaves ACTIVE and a corrected rate takes over.
    setRates([
      { ...original, status: 'SUPERSEDED', supersededByRateId: 'rate-b' },
      rate({ id: 'rate-b', base: 'USD', quote: 'IDR', rate: '17000', from: '2026-01-01T00:00:00.000Z' }),
    ]);

    // The retained result is a plain value: it cannot silently change.
    assert.equal(first.convertedAmount, '1650000', 'a retained conversion must never change');
    assert.equal(first.provenance.rate, '16500');
    assert.equal(first.provenance.fxRateId, 'rate-a');

    // A NEW conversion at the same reference date resolves the current ACTIVE rate.
    const second = await fxConversionService.convert(
      { clientId: CLIENT_ID, sourceCurrencyCode: 'USD', targetCurrencyCode: 'IDR', amount: '100', referenceDate: '2026-03-15T00:00:00.000Z' },
      gateway,
    );
    assert.equal(second.convertedAmount, '1700000');
    assert.equal(second.provenance.fxRateId, 'rate-b');
    assert.notEqual(first.provenance.fxRateId, second.provenance.fxRateId);
  });

  it('never backfills or rewrites historical data — the service performs no writes', () => {
    for (const file of ['fx-conversion.service.ts', 'fx-reporting.service.ts', 'fx-conversion.gateway.ts']) {
      const body = stripComments(readFileSync(resolve(FX_PATH, file), 'utf8'));
      assert.doesNotMatch(body, /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/i);
    }
  });
});

describe('CR-BE-FX-01 PART 05 — §9 inverse safety', () => {
  const USD_IDR = { id: 'rate-direct', base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' };

  it('is policy-gated: denied by default, allowed when opted in', async () => {
    const denied = mutableGateway([rate(USD_IDR)], clientPolicy({ inversePermitted: false, reportingCurrencyCode: 'USD' }));
    await assert.rejects(
      fxConversionService.convert(
        { clientId: CLIENT_ID, sourceCurrencyCode: 'IDR', targetCurrencyCode: 'USD', amount: '1980000', referenceDate: '2026-03-15T00:00:00.000Z' },
        denied.gateway,
      ),
      (e: unknown) => (e as { code?: string }).code === 'FX_INVERSE_NOT_PERMITTED',
    );

    const allowed = mutableGateway([rate(USD_IDR)], clientPolicy({ inversePermitted: true, reportingCurrencyCode: 'USD' }));
    const result = await fxConversionService.convert(
      { clientId: CLIENT_ID, sourceCurrencyCode: 'IDR', targetCurrencyCode: 'USD', amount: '1980000', referenceDate: '2026-03-15T00:00:00.000Z' },
      allowed.gateway,
    );
    assert.equal(result.conversionMode, 'INVERSE');
    assert.equal(result.provenance.rate, '16500', 'the stored rate is retained, never a persisted reciprocal');
    assert.equal(result.provenance.rateBaseCurrencyCode, 'USD');
    assert.equal(result.provenance.rateQuoteCurrencyCode, 'IDR');
  });

  it('is used only when no direct rate resolves', async () => {
    const both = mutableGateway(
      [rate(USD_IDR), rate({ id: 'rate-reverse', base: 'IDR', quote: 'USD', rate: '0.00006', from: '2026-01-01T00:00:00.000Z' })],
      clientPolicy({ inversePermitted: true }),
    );
    const result = await fxConversionService.convert(
      { clientId: CLIENT_ID, sourceCurrencyCode: 'USD', targetCurrencyCode: 'IDR', amount: '100', referenceDate: '2026-03-15T00:00:00.000Z' },
      both.gateway,
    );
    assert.equal(result.conversionMode, 'DIRECT');
    assert.equal(result.provenance.fxRateId, 'rate-direct');
  });

  it('uses at most one stored rate row and never triangulates', () => {
    const source = stripComments(readFileSync(resolve(FX_PATH, 'fx-conversion.service.ts'), 'utf8'));
    assert.equal(source.match(/gateway\.findActiveCovering\(/g)?.length, 2, 'direct + reverse only');
    assert.doesNotMatch(source, /for\s*\(\s*(const|let)\s+\w+\s+of\s+[\w.]*currenc/i, 'no loop over intermediate currencies');
  });
});

describe('CR-BE-FX-01 PART 05 — §10 UNKNOWN currency stays non-convertible', () => {
  it('is never treated as identity, IDR, base or reporting currency', async () => {
    const { gateway } = mutableGateway([rate({ id: 'r', base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' })]);
    for (const sourceCurrencyCode of [null, undefined, '']) {
      await assert.rejects(
        fxConversionService.convert(
          { clientId: CLIENT_ID, sourceCurrencyCode, targetCurrencyCode: 'IDR', amount: '500', referenceDate: '2026-03-15T00:00:00.000Z' },
          gateway,
        ),
        (e: unknown) => (e as { code?: string }).code === 'FX_UNKNOWN_CURRENCY_NOT_CONVERTIBLE',
      );
    }
  });

  it('lands in the unconvertible bucket through the reporting layer', async () => {
    const { gateway } = mutableGateway([rate({ id: 'r', base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' })]);
    const view = await fxReportingService.buildReportingCurrencyView({
      clientId: CLIENT_ID,
      gateway,
      facts: [
        { sourceType: 'VENDOR_SERVICE_COST', sourceId: 'known', amount: '100', currencyCode: 'USD', businessDate: '2026-03-15T00:00:00.000Z' },
        { sourceType: 'BASIC_EXPENSE', sourceId: 'unknown', amount: '777', currencyCode: null, businessDate: '2026-03-15T00:00:00.000Z' },
      ],
    });
    assert.equal(view.convertedTotal, null, 'no partial converted grand total');
    assert.deepEqual(view.unconvertible.map((u) => u.sourceId), ['unknown']);
    assert.equal(view.unconvertible[0]?.reason, 'UNKNOWN_SOURCE_CURRENCY');
    assert.deepEqual(
      view.originalCurrencyTotals,
      [
        { currencyCode: 'USD', amount: '100', count: 1 },
        { currencyCode: null, amount: '777', count: 1 },
      ],
      'the original-currency view is unaffected and still authoritative',
    );
  });
});

describe('CR-BE-FX-01 PART 05 — §4/§7 reporting stays additive with exact provenance', () => {
  it('keeps original values authoritative and never collapses distinct rates', async () => {
    const { gateway } = mutableGateway([
      rate({ id: 'rate-mar', base: 'USD', quote: 'IDR', rate: '16500', from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' }),
      rate({ id: 'rate-jun', base: 'USD', quote: 'IDR', rate: '17200', from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' }),
    ]);
    const view = await fxReportingService.buildReportingCurrencyView({
      clientId: CLIENT_ID,
      gateway,
      facts: [
        { sourceType: 'VENDOR_SERVICE_COST', sourceId: 'mar', amount: '100', currencyCode: 'USD', businessDate: '2026-03-15T00:00:00.000Z' },
        { sourceType: 'VENDOR_SERVICE_COST', sourceId: 'jun', amount: '100', currencyCode: 'USD', businessDate: '2026-06-15T00:00:00.000Z' },
      ],
    });
    assert.equal(view.convertedTotal?.completeness, 'COMPLETE');
    assert.equal(view.convertedTotal?.amount, '3370000');
    assert.deepEqual(view.originalCurrencyTotals, [{ currencyCode: 'USD', amount: '200', count: 2 }]);
    assert.equal('rate' in view, false, 'no report-level average or fake rate');
    assert.equal('fxRateId' in view, false);
    const ids = new Set(view.convertedComponents.map((c) => c.provenance.fxRateId));
    assert.deepEqual([...ids].sort(), ['rate-jun', 'rate-mar']);
  });
});

describe('CR-BE-FX-01 PART 05 — §16 no new public FX surface', () => {
  it('exposes no conversion, quote, reporting or provider endpoint', () => {
    const routes = read('fx-rates/fx-rate.routes.ts');
    const paths = [...routes.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
    assert.equal(paths.length, 10);
    for (const path of paths) {
      assert.doesNotMatch(path, /convert|quote|resolve|ingest|dashboard|reporting/i, `${path} must not exist`);
    }
    const registry = stripComments(readFileSync(resolve(SRC, 'routes/index.ts'), 'utf8'));
    assert.doesNotMatch(registry, /fx-reporting|fx-conversion/, 'the reporting layer stays internal');
  });
});
