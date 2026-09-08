import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

import { FX_RATE_EVENT_TYPES, FX_RATE_SOURCES, FX_RATE_STATUSES, FX_RATE_TYPES } from '../src/modules/fx-rates/fx-rate.types';
import {
  FOUNDATION_PERMISSIONS,
  UNASSIGNED_BY_DEFAULT_PERMISSION_CODES,
} from '../src/database/seeds/foundation-access.seed';
import type { ClientFxPolicy, FxRate } from '../src/modules/fx-rates/fx-rate.types';

/**
 * CR-BE-FX-01 PART 06 — OpenAPI/runtime contract alignment and governance closure.
 *
 * Dependency-free, so it executes in any environment. OpenAPI structure is read
 * by indentation-scoped text extraction rather than a YAML parser; the results
 * were cross-checked against a real YAML parse, and the stricter structural
 * check (path/ref integrity) lives in `fx06-part06-openapi-contract.test.ts`,
 * which follows the repository's `yaml`-based OpenAPI test convention.
 */

const SRC = resolve('src');
const ROOT = resolve('.');
const MIGRATION = resolve(SRC, 'database/migrations/0333_create_fx_rate_authority_and_client_fx_policy.ts');
const OPENAPI = resolve('docs/api/openapi.yaml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .map((line) => line.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

/** Collapses whitespace so YAML folded-scalar prose can be matched literally. */
function fold(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** Extracts the enum of a named OpenAPI component schema, scoped by indentation. */
function openApiEnum(schema: string): string[] {
  const src = read(OPENAPI);
  const head = new RegExp(`^    ${schema}:\\s*$`, 'm').exec(src);
  assert.ok(head, `OpenAPI schema ${schema} must exist`);
  let block = src.slice(head.index + head[0].length);
  const stop = /^ {4}[A-Za-z]/m.exec(block);
  if (stop) block = block.slice(0, stop.index);
  const inline = /enum:\s*\[([^\]]*)\]/.exec(block);
  if (inline) return inline[1].split(',').map((v) => v.trim()).filter(Boolean).sort();
  const listed = /enum:\s*\n((?:\s+-\s+\S+\n)+)/.exec(block);
  assert.ok(listed, `OpenAPI schema ${schema} must declare an enum`);
  return [...listed![1].matchAll(/-\s+(\S+)/g)].map((m) => m[1]!).sort();
}

/** Extracts exactly the values inside a named CHECK constraint in the migration. */
function dbCheckEnum(constraint: string): string[] {
  const src = read(MIGRATION);
  const at = src.indexOf(constraint);
  assert.ok(at >= 0, `0333 must define ${constraint}`);
  const open = src.indexOf('(', at);
  let depth = 0;
  let i = open;
  for (; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return [...src.slice(open, i + 1).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!).sort();
}

/** The DDL column list of a CREATE TABLE, stopping at its first CONSTRAINT. */
function ddlColumns(table: string): string[] {
  const src = read(MIGRATION);
  const at = src.indexOf(`CREATE TABLE ${table}`);
  assert.ok(at >= 0, `0333 must create ${table}`);
  const seg = src.slice(at, src.indexOf('CONSTRAINT', at));
  return [...seg.matchAll(/^ {8}([a-z_]+)\s+(?:UUID|TEXT|BOOLEAN|VARCHAR|NUMERIC|SMALLINT|TIMESTAMPTZ)/gm)]
    .map((m) => m[1]!);
}

const camel = (snake: string) => snake.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const typeFields = (typeName: string): string[] => {
  const src = read(resolve(SRC, 'modules/fx-rates/fx-rate.types.ts'));
  const at = src.indexOf(`export type ${typeName} = {`);
  assert.ok(at >= 0, `${typeName} must be declared`);
  const seg = src.slice(at, src.indexOf('};', at));
  return [...seg.matchAll(/^ {2}([a-zA-Z]+)[?]?:/gm)].map((m) => m[1]!).sort();
};

describe('CR-BE-FX-01 PART 06 — §1 public surface is exactly lifecycle + policy', () => {
  const routes = read(resolve(SRC, 'modules/fx-rates/fx-rate.routes.ts'));
  const registered = [...routes.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)]
    .map((m) => `${m[1]!.toUpperCase()} ${m[2]!.replace(/:([A-Za-z]+)/g, '{$1}')}`)
    .sort();

  it('registers exactly ten operations', () => {
    assert.deepEqual(registered, [
      'GET /clients/{clientId}/fx-policy',
      'GET /fx-rates',
      'GET /fx-rates/{rateId}',
      'GET /fx-rates/{rateId}/events',
      'POST /fx-rates',
      'POST /fx-rates/{rateId}/approve',
      'POST /fx-rates/{rateId}/deactivate',
      'POST /fx-rates/{rateId}/reject',
      'POST /fx-rates/{rateId}/supersede',
      'PUT /clients/{clientId}/fx-policy',
    ]);
  });

  it('exposes no conversion, quote, reporting-conversion or provider endpoint', () => {
    for (const path of registered) {
      assert.doesNotMatch(path, /convert|quote|resolve|ingest|dashboard|reporting|provider/i, path);
    }
    const openapi = read(OPENAPI);
    assert.doesNotMatch(openapi, /^\s+\/fx\/(convert|quote)/m);
    assert.doesNotMatch(openapi, /^\s+\/fx-rates\/(convert|resolve|quote)/m);
  });

  it('documents every registered operation and nothing more', () => {
    const openapi = read(OPENAPI);
    const documented = [...openapi.matchAll(/^ {2}(\/(?:fx-rates|clients\/\{clientId\}\/fx-policy)[^:]*):/gm)]
      .map((m) => m[1]!)
      .sort();
    const expectedPaths = [...new Set(registered.map((r) => r.split(' ')[1]!))].sort();
    assert.deepEqual(documented, expectedPaths);
  });
});

describe('CR-BE-FX-01 PART 06 — §2 contract enums match the authority three ways', () => {
  const cases = [
    ['FxRateStatus', 'fx_rates_status_check', FX_RATE_STATUSES],
    ['FxRateType', 'fx_rates_rate_type_check', FX_RATE_TYPES],
    ['FxRateSource', 'fx_rates_source_check', FX_RATE_SOURCES],
    ['FxRateEventType', 'fx_rate_events_event_type_check', FX_RATE_EVENT_TYPES],
  ] as const;

  for (const [schema, constraint, runtime] of cases) {
    it(`${schema}: OpenAPI == runtime == 0333 CHECK`, () => {
      const openapi = openApiEnum(schema);
      const db = dbCheckEnum(constraint);
      const rt = [...runtime].sort();
      assert.deepEqual(openapi, rt, 'OpenAPI must equal the runtime union');
      assert.deepEqual(db, rt, 'the 0333 CHECK must equal the runtime union');
    });
  }

  it('freezes the canonical convention 1 BASE = RATE x QUOTE in the contract', () => {
    const openapi = read(OPENAPI);
    assert.match(openapi, /1 BASE = RATE x QUOTE/);
    assert.match(openapi, /QUOTE units per ONE unit of BASE/);
    // A rate is a NUMERIC(24,12) ratio, so it must travel as a string, not a float.
    const rateProp = / {8}rate:\n {10}type: string/.test(openapi);
    assert.ok(rateProp, 'FxRate.rate and CreateFxRateRequest.rate must be typed as string');
  });

  it('documents only REFERENCE and only MANUAL_TREASURY', () => {
    assert.deepEqual(openApiEnum('FxRateType'), ['REFERENCE']);
    assert.deepEqual(openApiEnum('FxRateSource'), ['MANUAL_TREASURY']);
  });

  it('documents the full lifecycle including all three terminal states', () => {
    assert.deepEqual(openApiEnum('FxRateStatus'), [
      'ACTIVE', 'INACTIVE', 'PENDING_APPROVAL', 'REJECTED', 'SUPERSEDED',
    ]);
  });
});

describe('CR-BE-FX-01 PART 06 — §2 schema shapes match runtime and DDL', () => {
  it('FxRate: 0333 columns == runtime type == OpenAPI properties', () => {
    const db = ddlColumns('fx_rates').map(camel).sort();
    const rt = typeFields('FxRate');
    assert.deepEqual(rt, db);
    const openapi = read(OPENAPI);
    const head = /^ {4}FxRate:\s*$/m.exec(openapi)!;
    let block = openapi.slice(head.index + head[0].length);
    const props = /^ {6}properties:\s*$/m.exec(block)!;
    block = block.slice(props.index + props[0].length);
    const stop = /^ {4}[A-Za-z]/m.exec(block);
    if (stop) block = block.slice(0, stop.index);
    const documented = [...block.matchAll(/^ {8}([a-zA-Z]+):/gm)].map((m) => m[1]!).sort();
    assert.deepEqual(documented, rt);
  });

  it('ClientFxPolicy: 0333 columns == runtime type == OpenAPI properties', () => {
    const db = ddlColumns('client_fx_policies').map(camel).sort();
    const rt = typeFields('ClientFxPolicy');
    assert.deepEqual(rt, db);
    const openapi = read(OPENAPI);
    const head = /^ {4}ClientFxPolicy:\s*$/m.exec(openapi)!;
    let block = openapi.slice(head.index + head[0].length);
    const props = /^ {6}properties:\s*$/m.exec(block)!;
    block = block.slice(props.index + props[0].length);
    const stop = /^ {4}[A-Za-z]/m.exec(block);
    if (stop) block = block.slice(0, stop.index);
    const documented = [...block.matchAll(/^ {8}([a-zA-Z]+):/gm)].map((m) => m[1]!).sort();
    assert.deepEqual(documented, rt);
    // The frozen staleness/effective policy field is implemented and documented.
    assert.ok(documented.includes('maxStalenessDays'));
    assert.ok(db.includes('maxStalenessDays'));
  });

  it('Client FX Policy has no Building override anywhere', () => {
    assert.ok(!ddlColumns('client_fx_policies').includes('building_id'));
    const openapi = read(OPENAPI);
    const head = /^ {4}ClientFxPolicy:\s*$/m.exec(openapi)!;
    let block = openapi.slice(head.index + head[0].length);
    const stop = /^ {4}[A-Za-z]/m.exec(block);
    if (stop) block = block.slice(0, stop.index);
    assert.doesNotMatch(block, /buildingId/);
  });

  it('documents fail-closed policy defaults', () => {
    const openapi = read(OPENAPI);
    const head = /^ {4}SetClientFxPolicyRequest:\s*$/m.exec(openapi)!;
    let block = openapi.slice(head.index + head[0].length);
    const stop = /^ {4}[A-Za-z]/m.exec(block);
    if (stop) block = block.slice(0, stop.index);
    for (const field of ['fxEnabled', 'inversePermitted']) {
      const prop = new RegExp(` {8}${field}:[\\s\\S]{0,200}?default: false`).test(block);
      assert.ok(prop, `${field} must default to false in the contract`);
    }
  });

  it('supersession cannot change the currency pair through the contract', () => {
    const openapi = read(OPENAPI);
    const head = /^ {4}SupersedeFxRateRequest:\s*$/m.exec(openapi)!;
    let block = openapi.slice(head.index + head[0].length);
    const stop = /^ {4}[A-Za-z]/m.exec(block);
    if (stop) block = block.slice(0, stop.index);
    assert.doesNotMatch(block, /CurrencyCode/);
    assert.match(block, / {8}rate:\n {10}type: string/);
    // `rate` is optional: a window-only correction reuses the incumbent decimal.
    assert.match(fold(block), /Omit for a window-only correction/);
    assert.doesNotMatch(block, /^ {6}required:[\s\S]{0,120}?\n {8}- rate$/m);
  });
});

describe('CR-BE-FX-01 PART 06 — §3 permission contract', () => {
  const routes = read(resolve(SRC, 'modules/fx-rates/fx-rate.routes.ts'));

  it('gates each operation with the documented permission', () => {
    const expected: Record<string, string> = {
      'GET /fx-rates': 'fx_rate.read',
      'POST /fx-rates': 'fx_rate.manage',
      'GET /fx-rates/{rateId}': 'fx_rate.read',
      'GET /fx-rates/{rateId}/events': 'fx_rate.read',
      'POST /fx-rates/{rateId}/approve': 'fx_rate.approve',
      'POST /fx-rates/{rateId}/reject': 'fx_rate.approve',
      'POST /fx-rates/{rateId}/supersede': 'fx_rate.approve',
      'POST /fx-rates/{rateId}/deactivate': 'fx_rate.approve',
      'GET /clients/{clientId}/fx-policy': 'client_fx_policy.read',
      'PUT /clients/{clientId}/fx-policy': 'client_fx_policy.manage',
    };
    for (const m of routes.matchAll(/router\.(get|post|put)\(\s*'([^']+)',\s*auth,\s*(\w+),/g)) {
      const key = `${m[1]!.toUpperCase()} ${m[2]!.replace(/:([A-Za-z]+)/g, '{$1}')}`;
      const alias: Record<string, string> = {
        read: 'fx_rate.read', manage: 'fx_rate.manage', approve: 'fx_rate.approve',
        policyRead: 'client_fx_policy.read', policyManage: 'client_fx_policy.manage',
      };
      assert.equal(alias[m[3]!], expected[key], `${key} must be gated by ${expected[key]}`);
    }
  });

  it('matches x-required-permission in the contract', () => {
    const openapi = read(OPENAPI);
    for (const code of [
      'fx_rate.read', 'fx_rate.manage', 'fx_rate.approve',
      'client_fx_policy.read', 'client_fx_policy.manage',
    ]) {
      assert.ok(openapi.includes(`x-required-permission: ${code}`), `${code} must be documented`);
    }
  });

  it('registers exactly five FX permissions and keeps approve unassigned', () => {
    const fx = FOUNDATION_PERMISSIONS.filter((p) => /^fx_rate\.|^client_fx_policy\./.test(p.code))
      .map((p) => p.code).sort();
    assert.deepEqual(fx, [
      'client_fx_policy.manage', 'client_fx_policy.read',
      'fx_rate.approve', 'fx_rate.manage', 'fx_rate.read',
    ]);
    assert.ok(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('fx_rate.approve'));
    assert.ok(!UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('fx_rate.manage'));
    assert.ok(!UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('fx_rate.read'));
  });

  it('adds no role', () => {
    const seed = read(resolve(SRC, 'database/seeds/foundation-access.seed.ts'));
    assert.equal((seed.match(/const [A-Z_]+_ROLE = \{/g) ?? []).length, 1);
  });

  it('states maker-checker truthfully in the contract', () => {
    const openapi = read(OPENAPI);
    const at = openapi.indexOf('operationId: approveFxRate');
    const block = fold(openapi.slice(at, at + 1600));
    // YAML folded scalars wrap prose, so whitespace is normalised before matching.
    assert.match(block, /approver must not be the maker/);
    assert.match(block, /FX_RATE_SELF_APPROVAL/);
    assert.match(block, /FX_RATE_ACTIVE_WINDOW_CONFLICT/);
    assert.match(block, /"409"/);
    // Proposing is explicitly not activating.
    const create = fold(openapi.slice(openapi.indexOf('operationId: createFxRate')));
    assert.match(create, /PENDING_APPROVAL/);
    assert.match(create, /It is NOT usable by any consumer until a different authorized user approves it/);
  });
});

describe('CR-BE-FX-01 PART 06 — §4 conversion authority closure', () => {
  const fxPath = resolve(SRC, 'modules/fx-rates');

  it('is the single runtime conversion authority, consumed only by reporting', () => {
    const consumers = readdirSync(fxPath).length > 0
      ? [fxPath, resolve(SRC, 'modules/currency-reporting'), resolve(SRC, 'routes')]
      : [];
    void consumers;
    const reporting = stripComments(read(resolve(fxPath, 'fx-reporting.service.ts')));
    assert.match(reporting, /fxConversionService\.convert\(/);
    // The reporting layer performs no rate lookup or arithmetic of its own.
    assert.doesNotMatch(reporting, /\bfx_rates\b|findAllActiveCovering|maxStalenessDays/);
    assert.doesNotMatch(reporting, /[\w)\]]\s*[*/]\s*(?:[A-Za-z_][A-Za-z0-9_]*)?[Rr]ate\b/);
  });

  it('owns resolution, DIRECT/INVERSE/IDENTITY, staleness, precision, rounding and provenance', () => {
    const service = stripComments(read(resolve(fxPath, 'fx-conversion.service.ts')));
    assert.match(service, /function applyRate\(/);
    assert.match(service, /'DIRECT'/);
    assert.match(service, /'INVERSE'/);
    assert.match(service, /'IDENTITY'/);
    assert.match(service, /maxStalenessDays/);
    assert.match(service, /targetPrecision/);
    assert.match(service, /HALF_UP/);
    assert.match(service, /fxRateId/);
  });

  it('exposes no public conversion endpoint', () => {
    const routes = read(resolve(fxPath, 'fx-rate.routes.ts'));
    assert.doesNotMatch(routes, /convert|quote|resolve/i);
    const registry = stripComments(read(resolve(SRC, 'routes/index.ts')));
    assert.doesNotMatch(registry, /fx-reporting|fx-conversion/);
  });
});

describe('CR-BE-FX-01 PART 06 — §5 reporting integration closure', () => {
  it('integrates currency-reporting only, additively', () => {
    const adapter = read(resolve(SRC, 'modules/currency-reporting/reporting-currency-read-model.ts'));
    assert.match(adapter, /import \{ getOperationalCurrencySummary \} from '\.\/index'/);
    const index = read(resolve(SRC, 'modules/currency-reporting/index.ts'));
    assert.match(index, /GROUP BY currency_code/);
    assert.doesNotMatch(index, /fxReportingService|fx-conversion|reportingCurrency/);
  });

  it('preserves original-currency outputs and complete-or-null total semantics', () => {
    const reporting = stripComments(read(resolve(SRC, 'modules/fx-rates/fx-reporting.service.ts')));
    assert.match(reporting, /originalCurrencyTotals/);
    assert.match(reporting, /completeness: 'COMPLETE'/);
    assert.match(reporting, /unconvertible/);
    assert.doesNotMatch(reporting, /convertedSubtotal|partialTotal/);
    // Converted total is returned only when nothing is unconvertible.
    assert.match(reporting, /unconvertible\.length === 0/);
  });

  it('keeps operational controls exact-currency and renderers FX-free', () => {
    const variance = stripComments(read(resolve(SRC, 'modules/operational-finance/operational-variance.service.ts')));
    assert.match(variance, /SOURCE_CURRENCY_MISMATCH/);
    for (const renderer of ['csv-renderer.ts', 'xlsx-renderer.ts', 'pdf-renderer.ts']) {
      const body = read(resolve(SRC, 'modules/reporting-export', renderer));
      assert.doesNotMatch(body, /fx|currency/i, `${renderer} must perform no FX`);
    }
  });
});

describe('CR-BE-FX-01 PART 06 — §6 MATERIALIZED FX CONVERSION = NOT REQUIRED', () => {
  it('has no conversion ledger and no 0334', () => {
    const migrations = resolve(SRC, 'database/migrations');
    assert.equal(existsSync(resolve(migrations, '0334_create_fx_conversion_ledger.ts')), false);
    assert.equal(
      readdirSync(migrations).filter((f) => /^\d{4}_/.test(f)).sort().at(-1),
      '0333_create_fx_rate_authority_and_client_fx_policy.ts',
    );
  });

  it('persists no converted monetary amount anywhere', () => {
    const migrations = resolve(SRC, 'database/migrations');
    for (const file of readdirSync(migrations)) {
      if (!/^\d{4}_.*\.ts$/.test(file)) continue;
      const body = read(resolve(migrations, file));
      assert.doesNotMatch(body, /converted_amount|reporting_amount|converted_currency/, file);
    }
  });

  it('writes no fx_rate_id into any transaction table', () => {
    const migration = read(MIGRATION);
    const occurrences = [...migration.matchAll(/fx_rate_id/g)].length;
    assert.equal(occurrences, 2, 'the column and its index, both on fx_rate_events');
    const table = migration.slice(migration.indexOf('CREATE TABLE fx_rate_events'));
    assert.match(table, /fx_rate_id\s+UUID NOT NULL REFERENCES fx_rates \(id\)/);
    const ratesTable = migration.slice(
      migration.indexOf('CREATE TABLE fx_rates ('),
      migration.indexOf('CREATE TABLE fx_rate_events'),
    );
    assert.doesNotMatch(ratesTable, /fx_rate_id/);
  });

  it('has no conversion audit flood', () => {
    for (const file of ['fx-conversion.service.ts', 'fx-reporting.service.ts', 'fx-conversion.gateway.ts']) {
      const body = stripComments(read(resolve(SRC, 'modules/fx-rates', file)));
      assert.doesNotMatch(body, /recordOperationalEvent|fxRateEventRepository|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
    }
  });
});

describe('CR-BE-FX-01 PART 06 — §7 exact-currency boundaries reconfirmed', () => {
  const guards: Array<[string, RegExp]> = [
    ['vendor-quotations/vendor-quotation.service.ts', /currency !== rfq\.currency/],
    ['rfq-comparisons/rfq-comparison.service.ts', /selected\.currency !== rfq\.currency/],
    ['rfq-po-conversions/rfq-po-conversion.service.ts', /quotation\.currency !== rfq\.currency/],
    ['vendor-invoices/vendor-invoice.service.ts', /purchaseOrder\.currency !== invoice\.currency/],
    ['operational-finance/operational-commitment.service.ts', /input\.currency !== locked\.currency/],
    ['operational-finance/operational-finance-binding.service.ts', /operationalBudgetSourceCurrencyMismatchError/],
    ['operational-finance/operational-commitment-vendor.service.ts', /outcome: 'CURRENCY_MISMATCH'/],
    ['operational-finance/operational-commitment-material.service.ts', /outcome: 'CURRENCY_MISMATCH'/],
    ['tenant-invoices/tenant-invoice.service.ts', /tenantInvoiceCurrencyMismatchError/],
    ['price-catalog-entries/price-catalog-lookup.service.ts', /CURRENCY_INCOMPATIBLE/],
  ];

  for (const [file, pattern] of guards) {
    it(`${file.split('/')[0]} keeps its currency equality guard`, () => {
      const body = stripComments(read(resolve(SRC, 'modules', file)));
      assert.match(body, pattern);
      assert.doesNotMatch(body, /fxConversionService|fxReportingService|fx-conversion|fx-reporting/);
    });
  }
});

describe('CR-BE-FX-01 PART 06 — §8 provider boundary', () => {
  it('supports MANUAL_TREASURY only', () => {
    assert.deepEqual([...FX_RATE_SOURCES], ['MANUAL_TREASURY']);
    assert.match(read(MIGRATION), /source IN \('MANUAL_TREASURY'\)/);
  });

  it('has no Bank Indonesia, external API, scheduler, poller or worker', () => {
    for (const file of readdirSync(resolve(SRC, 'modules/fx-rates'))) {
      if (!file.endsWith('.ts')) continue;
      const body = read(resolve(SRC, 'modules/fx-rates', file));
      assert.doesNotMatch(body, /BANK_INDONESIA|EXTERNAL_API|setInterval|setTimeout|due-job-scheduler|due-job-dispatcher|fetch\(/i, file);
    }
    const registry = read(resolve(SRC, 'routes/index.ts'));
    assert.doesNotMatch(registry, /fx.*(scheduler|ingest|poll)/i);
  });
});

describe('CR-BE-FX-01 PART 06 — §9/§10 governance debt and historical compatibility', () => {
  const doc = () => read(resolve(ROOT, 'docs/CR-BE-FX-01_START_GOVERNANCE.md'));

  it('carries the event-vocabulary debt without renaming or migrating', () => {
    assert.ok(FX_RATE_EVENT_TYPES.includes('FX_RATE_APPROVED'));
    assert.ok(!(FX_RATE_EVENT_TYPES as readonly string[]).includes('FX_RATE_ACTIVATED'));
    assert.doesNotMatch(read(MIGRATION), /FX_RATE_ACTIVATED/);
    assert.match(doc(), /FX_RATE_ACTIVATED/);
  });

  it('records CR-BE-FIN-RPT-01 and keeps basic-financial-reporting FX-free', () => {
    assert.match(doc(), /CR-BE-FIN-RPT-01/);
    for (const file of readdirSync(resolve(SRC, 'modules/basic-financial-reporting'))) {
      if (!file.endsWith('.ts')) continue;
      assert.doesNotMatch(
        read(resolve(SRC, 'modules/basic-financial-reporting', file)),
        /fxConversionService|fxReportingService|fx-conversion|fx-reporting|fx-rates\//,
        file,
      );
    }
  });

  it('never rewrites historical transactions and performs no backfill', () => {
    const migration = read(MIGRATION);
    assert.doesNotMatch(migration, /\bUPDATE\s+[a-z_]+\s+SET\b/i);
    assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i);
    assert.doesNotMatch(migration, /\bTRUNCATE\b/i);
    // 0333 creates only its own three tables and alters only fx_rates.
    const altered = [...migration.matchAll(/ALTER TABLE\s+([a-z_]+)/gi)].map((m) => m[1]);
    assert.deepEqual([...new Set(altered)], ['fx_rates']);
    for (const file of ['fx-conversion.service.ts', 'fx-reporting.service.ts', 'fx-conversion.gateway.ts', 'fx-rate-lifecycle.service.ts']) {
      const body = stripComments(read(resolve(SRC, 'modules/fx-rates', file)));
      assert.doesNotMatch(body, /\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    }
  });

  it('keeps UNKNOWN non-convertible', () => {
    const service = stripComments(read(resolve(SRC, 'modules/fx-rates/fx-conversion.service.ts')));
    assert.match(service, /fxUnknownCurrencyNotConvertibleError/);
    const reporting = stripComments(read(resolve(SRC, 'modules/fx-rates/fx-reporting.service.ts')));
    assert.match(reporting, /UNKNOWN_SOURCE_CURRENCY/);
  });
});

describe('CR-BE-FX-01 PART 06 — §11 final migration set', () => {
  it('is 0333 only', () => {
    const migrations = resolve(SRC, 'database/migrations');
    const fx = readdirSync(migrations).filter((f) => /fx/i.test(f));
    assert.deepEqual(fx, ['0333_create_fx_rate_authority_and_client_fx_policy.ts']);
    assert.equal(readdirSync(migrations).filter((f) => /^\d{4}_/.test(f)).length, 333);
  });

  it('is registered exactly once, in order', () => {
    const index = read(resolve(SRC, 'database/migrations/index.ts'));
    assert.equal((index.match(/migration0333CreateFxRateAuthorityAndClientFxPolicy/g) ?? []).length, 2);
    const order = [...index.matchAll(/^ {2}(migration\w+)/gm)].map((m) => m[1]!);
    assert.equal(order.at(-1), 'migration0333CreateFxRateAuthorityAndClientFxPolicy');
  });
});
