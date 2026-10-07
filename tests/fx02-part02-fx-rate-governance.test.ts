import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  FOUNDATION_PERMISSIONS,
  UNASSIGNED_BY_DEFAULT_PERMISSION_CODES,
} from '../src/database/seeds/foundation-access.seed';
import {
  parseCreateFxRateBody,
  parseFxRateFilters,
  parseFxRateId,
  parseReasonBody,
  parseSetClientFxPolicyBody,
  parseSupersedeFxRateBody,
} from '../src/modules/fx-rates/fx-rate.request-validation';
import { FX_RATE_EVENT_TYPES } from '../src/modules/fx-rates/fx-rate.types';

/**
 * CR-BE-FX-01 PART 02 — FX Rate lifecycle + Client FX Policy governance.
 *
 * The database-free half of the PART 02 suite, so it executes in any
 * environment. It covers request-shape governance, RBAC wiring, the permission
 * catalogue, the audit-event vocabulary, and the standing "no conversion in
 * PART 02" rule.
 *
 * The database-enforced behaviour (maker-checker against a real row, the ACTIVE
 * window conflict, supersession lineage, event rows, Client isolation) is
 * covered by `fx02-part02-fx-rate-lifecycle.test.ts`, which skips when
 * PostgreSQL is unavailable.
 */

const MODULE_PATH = resolve('src/modules/fx-rates');
const ROUTES_PATH = resolve('src/modules/fx-rates/fx-rate.routes.ts');
const MIGRATIONS_PATH = resolve('src/database/migrations');
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Negative static assertions must look at CODE, not prose. Several PART 02 files
 * legitimately contain the words "conversion" and "rate" inside explanatory
 * comments, so comments are stripped before a "must not contain" check.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, ''))
    .join('\n');
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
}

function fieldsOf(error: unknown): string[] {
  const details = (error as { details?: { field?: string }[] })?.details ?? [];
  return details.map((d) => d.field ?? '');
}

describe('CR-BE-FX-01 PART 02 — create rate request governance', () => {
  it('accepts a well-formed proposal and normalizes currency codes', () => {
    const body = parseCreateFxRateBody({
      baseCurrencyCode: 'usd',
      quoteCurrencyCode: 'idr',
      rate: '16500',
      effectiveFrom: '2026-01-01T00:00:00Z',
      source: 'MANUAL_TREASURY',
    });
    assert.equal(body.baseCurrencyCode, 'USD');
    assert.equal(body.quoteCurrencyCode, 'IDR');
    assert.equal(body.rate, '16500');
    assert.equal(body.source, 'MANUAL_TREASURY');
  });

  it('rejects exponent notation, keeping the canonical 1 BASE = RATE x QUOTE decimal', () => {
    assert.throws(
      () => parseCreateFxRateBody({
        baseCurrencyCode: 'USD', quoteCurrencyCode: 'IDR', rate: '1e5',
        effectiveFrom: '2026-01-01', source: 'MANUAL_TREASURY',
      }),
      (error: unknown) => codeOf(error) === 'VALIDATION_ERROR' && fieldsOf(error).includes('rate'),
    );
  });

  it('rejects every non-MANUAL_TREASURY source — no provider ingestion exists', () => {
    for (const source of ['BANK_INDONESIA', 'ERP', 'EXTERNAL_API', '']) {
      assert.throws(
        () => parseCreateFxRateBody({
          baseCurrencyCode: 'USD', quoteCurrencyCode: 'IDR', rate: '16500',
          effectiveFrom: '2026-01-01', source,
        }),
        (error: unknown) => codeOf(error) === 'VALIDATION_ERROR' && fieldsOf(error).includes('source'),
        `source '${source}' must be rejected`,
      );
    }
  });

  it('reports every malformed field at once', () => {
    assert.throws(
      () => parseCreateFxRateBody({}),
      (error: unknown) => {
        const fields = fieldsOf(error);
        return (
          codeOf(error) === 'VALIDATION_ERROR' &&
          fields.includes('baseCurrencyCode') &&
          fields.includes('quoteCurrencyCode') &&
          fields.includes('rate') &&
          fields.includes('effectiveFrom') &&
          fields.includes('source')
        );
      },
    );
  });

  it('rejects a non-object body and a malformed rateId', () => {
    assert.throws(() => parseCreateFxRateBody([]), (e: unknown) => codeOf(e) === 'VALIDATION_ERROR');
    assert.throws(() => parseCreateFxRateBody(null), (e: unknown) => codeOf(e) === 'VALIDATION_ERROR');
    assert.throws(() => parseFxRateId('not-a-uuid'), (e: unknown) => codeOf(e) === 'VALIDATION_ERROR');
  });

  it('accepts a numeric rate but rejects non-finite numbers', () => {
    const body = parseCreateFxRateBody({
      baseCurrencyCode: 'USD', quoteCurrencyCode: 'IDR', rate: 16500.25,
      effectiveFrom: '2026-01-01', source: 'MANUAL_TREASURY',
    });
    assert.equal(body.rate, '16500.25');
    assert.throws(
      () => parseCreateFxRateBody({
        baseCurrencyCode: 'USD', quoteCurrencyCode: 'IDR', rate: Number.NaN,
        effectiveFrom: '2026-01-01', source: 'MANUAL_TREASURY',
      }),
      (error: unknown) => fieldsOf(error).includes('rate'),
    );
  });
});

describe('CR-BE-FX-01 PART 02 — supersession request governance', () => {
  it('allows a window-only correction that omits the rate', () => {
    const body = parseSupersedeFxRateBody({ effectiveFrom: '2026-07-01T00:00:00Z' });
    assert.equal(body.rate, undefined, 'omitted rate means the incumbent value is reused exactly');
    assert.equal(body.effectiveFrom, '2026-07-01T00:00:00.000Z');
  });

  it('validates a supplied correction rate', () => {
    const body = parseSupersedeFxRateBody({ rate: '16600.5', effectiveFrom: '2026-07-01T00:00:00Z' });
    assert.equal(body.rate, '16600.5');
    assert.throws(
      () => parseSupersedeFxRateBody({ rate: '-1', effectiveFrom: '2026-07-01T00:00:00Z' }),
      (error: unknown) => fieldsOf(error).includes('rate'),
    );
  });

  it('requires the successor effective window', () => {
    assert.throws(
      () => parseSupersedeFxRateBody({}),
      (error: unknown) => fieldsOf(error).includes('effectiveFrom'),
    );
  });

  it('never accepts a currency pair change through supersession', () => {
    // The parser has no currency fields at all: the pair is inherited by design.
    const source = readFileSync(resolve(MODULE_PATH, 'fx-rate.request-validation.ts'), 'utf8');
    const supersedeFn = source.slice(source.indexOf('parseSupersedeFxRateBody'));
    const body = supersedeFn.slice(0, supersedeFn.indexOf('export function parseReasonBody'));
    assert.doesNotMatch(body, /baseCurrencyCode|quoteCurrencyCode/);
  });
});

describe('CR-BE-FX-01 PART 02 — reject / deactivate reason governance', () => {
  it('trims an optional reason and rejects an oversized one', () => {
    assert.equal(parseReasonBody({ reason: '  stale rate sheet  ' }, 'reason'), 'stale rate sheet');
    assert.equal(parseReasonBody(undefined, 'reason'), null);
    assert.equal(parseReasonBody({}, 'reason'), null);
    assert.equal(parseReasonBody({ reason: '   ' }, 'reason'), null);
    assert.throws(
      () => parseReasonBody({ reason: 'x'.repeat(501) }, 'reason'),
      (error: unknown) => codeOf(error) === 'VALIDATION_ERROR',
    );
  });
});

describe('CR-BE-FX-01 PART 02 — Client FX policy request fails closed', () => {
  it('defaults fxEnabled and inversePermitted to false when absent', () => {
    const policy = parseSetClientFxPolicyBody(CLIENT_ID, {
      reportingCurrencyCode: 'IDR',
      permittedSources: ['MANUAL_TREASURY'],
    });
    assert.equal(policy.fxEnabled, false, 'absent fxEnabled must fail closed to false');
    assert.equal(policy.inversePermitted, false, 'absent inversePermitted must fail closed to false');
  });

  it('accepts an empty permittedSources array (permits nothing) without failing', () => {
    const policy = parseSetClientFxPolicyBody(CLIENT_ID, {
      reportingCurrencyCode: 'IDR',
      permittedSources: [],
    });
    assert.deepEqual(policy.permittedSources, []);
  });

  it('rejects a non-array or unknown permitted source', () => {
    for (const permittedSources of ['MANUAL_TREASURY', ['EXTERNAL_API'], [null]]) {
      assert.throws(
        () => parseSetClientFxPolicyBody(CLIENT_ID, {
          reportingCurrencyCode: 'IDR', permittedSources,
        }),
        (error: unknown) => fieldsOf(error).includes('permittedSources'),
        `permittedSources ${JSON.stringify(permittedSources)} must be rejected`,
      );
    }
  });

  it('requires an explicit reporting currency and never injects one', () => {
    assert.throws(
      () => parseSetClientFxPolicyBody(CLIENT_ID, { permittedSources: ['MANUAL_TREASURY'] }),
      (error: unknown) => fieldsOf(error).includes('reportingCurrencyCode'),
    );
    // The parser has no access to any Client base/default currency: injection is
    // structurally impossible at this layer.
    const source = readFileSync(resolve(MODULE_PATH, 'fx-rate.request-validation.ts'), 'utf8');
    const fn = source.slice(source.indexOf('parseSetClientFxPolicyBody'));
    assert.doesNotMatch(fn.slice(0, fn.indexOf('export function parseFxRateFilters')), /client_monetary_contexts|baseCurrency/);
  });

  it('rejects a non-positive or fractional staleness bound', () => {
    for (const maxStalenessDays of [0, -5, 1.5, '30']) {
      assert.throws(
        () => parseSetClientFxPolicyBody(CLIENT_ID, {
          reportingCurrencyCode: 'IDR', permittedSources: ['MANUAL_TREASURY'], maxStalenessDays,
        }),
        (error: unknown) => fieldsOf(error).includes('maxStalenessDays'),
        `maxStalenessDays ${JSON.stringify(maxStalenessDays)} must be rejected`,
      );
    }
    assert.equal(
      parseSetClientFxPolicyBody(CLIENT_ID, {
        reportingCurrencyCode: 'IDR', permittedSources: ['MANUAL_TREASURY'], maxStalenessDays: 30,
      }).maxStalenessDays,
      30,
    );
  });
});

describe('CR-BE-FX-01 PART 02 — read filter parsing', () => {
  it('normalizes codes and ignores malformed filters instead of guessing', () => {
    const filters = parseFxRateFilters({
      baseCurrencyCode: 'usd', status: 'ACTIVE', source: 'MANUAL_TREASURY',
      limit: '50', offset: '10',
    });
    assert.equal(filters.baseCurrencyCode, 'USD');
    assert.equal(filters.status, 'ACTIVE');
    assert.equal(filters.limit, 50);
    assert.equal(filters.offset, 10);

    const ignored = parseFxRateFilters({ status: 'NOT_A_STATUS', limit: '-1', baseCurrencyCode: 'x' });
    assert.equal(ignored.status, undefined);
    assert.equal(ignored.limit, undefined);
    assert.equal(ignored.baseCurrencyCode, undefined);
  });
});

describe('CR-BE-FX-01 PART 02 — RBAC catalogue', () => {
  const codes = new Set(FOUNDATION_PERMISSIONS.map((p) => p.code));

  it('registers exactly the five permissions the implemented commands need', () => {
    for (const code of [
      'fx_rate.read',
      'fx_rate.manage',
      'fx_rate.approve',
      'client_fx_policy.read',
      'client_fx_policy.manage',
    ]) {
      assert.ok(codes.has(code), `${code} must be registered`);
    }
  });

  it('does not invent a .create verb this repository has never used', () => {
    assert.ok(!codes.has('fx_rate.create'), 'this repository has no .create permission convention');
    const anyCreate = FOUNDATION_PERMISSIONS.filter((p) => p.code.endsWith('.create'));
    assert.deepEqual(anyCreate, [], 'no .create permission may exist');
  });

  it('withholds fx_rate.approve from PLATFORM_ADMIN by default', () => {
    assert.ok(
      UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('fx_rate.approve'),
      'approving a rate is an exceptional financial authority and must never be inherited',
    );
    assert.ok(
      !UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('fx_rate.manage'),
      'proposing a rate is not exceptional and stays grantable',
    );
  });

  it('introduces no new role', () => {
    const seed = readFileSync(resolve('src/database/seeds/foundation-access.seed.ts'), 'utf8');
    assert.match(seed, /code: 'PLATFORM_ADMIN'/);
    assert.equal((seed.match(/const [A-Z_]+_ROLE = \{/g) ?? []).length, 1, 'only PLATFORM_ADMIN may exist');
  });
});

describe('CR-BE-FX-01 PART 02 — HTTP surface is minimal and correctly gated', () => {
  const routes = readFileSync(ROUTES_PATH, 'utf8');

  it('exposes only lifecycle and policy routes', () => {
    const paths = [...routes.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)]
      .map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)
      .sort();
    assert.deepEqual(paths, [
      'GET /clients/:clientId/fx-policy',
      'GET /fx-rates',
      'GET /fx-rates/:rateId',
      'GET /fx-rates/:rateId/events',
      'POST /fx-rates',
      'POST /fx-rates/:rateId/approve',
      'POST /fx-rates/:rateId/deactivate',
      'POST /fx-rates/:rateId/reject',
      'POST /fx-rates/:rateId/supersede',
      'PUT /clients/:clientId/fx-policy',
    ]);
  });

  it('introduces no conversion, quote, ingestion or dashboard endpoint', () => {
    // Checked against the declared route paths, not the file's prose.
    const paths = [...routes.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)]
      .map((m) => m[2]!)
      .join(' ');
    assert.doesNotMatch(paths, /convert|quote|ingest|dashboard|reporting|revalue/i);
  });

  it('gates propose with manage and every transition with approve', () => {
    assert.match(routes, /router\.post\('\/fx-rates', auth, manage, createFxRateHandler\)/);
    for (const action of ['approve', 'reject', 'supersede', 'deactivate']) {
      assert.match(
        routes,
        new RegExp(`router\\.post\\('/fx-rates/:rateId/${action}', auth, approve,`),
        `${action} must require fx_rate.approve`,
      );
    }
    assert.match(routes, /router\.put\('\/clients\/:clientId\/fx-policy', auth, policyManage,/);
    assert.match(routes, /router\.get\('\/clients\/:clientId\/fx-policy', auth, policyRead,/);
  });

  it('requires authentication on every route', () => {
    const routeLines = routes.split('\n').filter((l) => /router\.(get|post|put|patch|delete)\(/.test(l));
    assert.ok(routeLines.length >= 10, 'all routes must be declared');
    for (const line of routeLines) {
      assert.match(line, /auth,/, `route must be authenticated: ${line.trim()}`);
    }
  });

  it('registers the router in the API router', () => {
    const registry = readFileSync(resolve('src/routes/index.ts'), 'utf8');
    assert.match(registry, /createFxRateRouter/);
  });
});

describe('CR-BE-FX-01 PART 02 — audit event vocabulary', () => {
  const service = readFileSync(resolve(MODULE_PATH, 'fx-rate-lifecycle.service.ts'), 'utf8');

  it('keeps the five governed event types', () => {
    assert.deepEqual([...FX_RATE_EVENT_TYPES], [
      'FX_RATE_CREATED', 'FX_RATE_APPROVED', 'FX_RATE_REJECTED',
      'FX_RATE_SUPERSEDED', 'FX_RATE_DEACTIVATED',
    ]);
  });

  it('emits an event for every lifecycle transition', () => {
    for (const eventType of FX_RATE_EVENT_TYPES) {
      assert.match(service, new RegExp(`eventType: '${eventType}'`), `${eventType} must be emitted`);
    }
  });

  it('writes audit rows to fx_rate_events, never to operational_events, for rates', () => {
    assert.match(service, /fxRateEventRepository\.append/);
    assert.doesNotMatch(service, /recordOperationalEvent/, 'platform-global rates have no Client owner');
  });

  it('uses the existing Client-scoped audit for FX policy only', () => {
    const policyService = readFileSync(resolve(MODULE_PATH, 'client-fx-policy.service.ts'), 'utf8');
    assert.match(policyService, /recordOperationalEvent/);
    assert.match(policyService, /CLIENT_FX_POLICY_SET/);
    assert.match(policyService, /CLIENT_FX_POLICY_CHANGED/);
    assert.doesNotMatch(policyService, /fxRateEventRepository/, 'policy must not use the rate ledger');
  });
});

describe('CR-BE-FX-01 PART 02 — lifecycle SQL matches the 0333 schema', () => {
  /**
   * The transition UPDATE interpolates column names, so a typo or a wrongly
   * assumed name is a runtime SQL error rather than a compile error — and the
   * schema is NOT uniformly named (`deactivation_reason`, not
   * `deactivated_reason`; no reason column for ACTIVE or SUPERSEDED). This
   * cross-checks every interpolated column against the migration's real
   * `fx_rates` definition.
   */
  const migration = readFileSync(
    resolve(MIGRATIONS_PATH, '0333_create_fx_rate_authority_and_client_fx_policy.ts'),
    'utf8',
  );
  const fxRatesTable = migration.slice(
    migration.indexOf('CREATE TABLE fx_rates ('),
    migration.indexOf('CREATE TABLE fx_rate_events'),
  );
  const columns = new Set(
    [...fxRatesTable.matchAll(/^\s{8}([a-z_]+)\s+(?:UUID|TEXT|VARCHAR|NUMERIC|TIMESTAMPTZ)/gm)]
      .map((m) => m[1]!),
  );

  it('reads a non-empty set of real columns out of the migration', () => {
    assert.ok(columns.size >= 20, `expected the fx_rates columns, got ${columns.size}`);
    for (const known of ['status', 'rate', 'rejected_reason', 'deactivation_reason']) {
      assert.ok(columns.has(known), `${known} must be a real fx_rates column`);
    }
  });

  it('only interpolates attribution columns that actually exist', () => {
    const repository = readFileSync(resolve(MODULE_PATH, 'fx-rate.repository.ts'), 'utf8');
    const block = repository.slice(
      repository.indexOf('const TRANSITION_COLUMNS'),
      repository.indexOf('export const fxRateRepository'),
    );
    // Object keys are unquoted in the source map.
    const referenced = [...block.matchAll(/\b(?:actor|at|reason):\s*'([a-z_]+)'/g)].map((m) => m[1]!);
    assert.ok(referenced.length >= 9, `expected the attribution columns, got ${referenced.length}`);
    for (const column of referenced) {
      assert.ok(columns.has(column), `interpolated column '${column}' does not exist in fx_rates`);
    }
  });

  it('maps every non-pending status and never invents a ${status}_reason column', () => {
    const repository = readFileSync(resolve(MODULE_PATH, 'fx-rate.repository.ts'), 'utf8');
    const block = repository.slice(
      repository.indexOf('const TRANSITION_COLUMNS'),
      repository.indexOf('export const fxRateRepository'),
    );
    for (const status of ['ACTIVE', 'REJECTED', 'SUPERSEDED', 'INACTIVE']) {
      assert.match(block, new RegExp(`^\\s*${status}:`, 'm'), `${status} must be mapped`);
    }
    // Checked against code only: the explanatory comment legitimately names the
    // wrong column to explain why the map is spelled out.
    assert.doesNotMatch(stripComments(repository), /deactivated_reason|approved_reason|superseded_reason/);
  });
});

describe('CR-BE-FX-01 PART 02 — no conversion and no migration introduced', () => {
  const partTwoFiles = [
    'fx-rate-lifecycle.service.ts',
    'client-fx-policy.service.ts',
    'fx-rate.controller.ts',
    'fx-rate.routes.ts',
    'fx-rate.request-validation.ts',
  ];

  it('converts nothing: no amount is multiplied or divided by a rate', () => {
    for (const file of partTwoFiles) {
      const body = stripComments(readFileSync(resolve(MODULE_PATH, file), 'utf8'));
      assert.doesNotMatch(body, /amount\s*[*/]\s*rate/i, `${file} must not convert`);
      assert.doesNotMatch(body, /\*\s*rate\b/i, `${file} must not multiply by a rate`);
      assert.doesNotMatch(body, /\/\s*rate\b/i, `${file} must not divide by a rate`);
    }
  });

  it('never mutates a stored rate value', () => {
    const service = stripComments(readFileSync(resolve(MODULE_PATH, 'fx-rate-lifecycle.service.ts'), 'utf8'));
    assert.doesNotMatch(service, /UPDATE fx_rates SET[^;]*\brate\s*=/i, 'the rate column is immutable');
    const repository = readFileSync(resolve(MODULE_PATH, 'fx-rate.repository.ts'), 'utf8');
    const updates = [...repository.matchAll(/UPDATE fx_rates SET([\s\S]*?)WHERE/g)].map((m) => m[1]);
    assert.ok(updates.length > 0, 'the repository must contain lifecycle updates');
    for (const clause of updates) {
      assert.doesNotMatch(clause, /(^|[^_a-z])rate\s*=/, 'no UPDATE may assign the rate column');
      assert.doesNotMatch(clause, /base_currency_code|quote_currency_code|effective_from\s*=|effective_to\s*=/);
    }
  });

  it('consumes no new migration and creates no 0334', () => {
    assert.equal(existsSync(resolve(MIGRATIONS_PATH, '0334_create_fx_conversion_ledger.ts')), false);
    const migrations = readdirSync(MIGRATIONS_PATH)
      .filter((f) => /^\d{4}_/.test(f))
      .sort();
    assert.equal(migrations.at(-1), '0333_create_fx_rate_authority_and_client_fx_policy.ts');
  });
});
