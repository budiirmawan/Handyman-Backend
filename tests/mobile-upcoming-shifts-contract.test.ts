import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-05 PART 01 — Mobile Upcoming Shifts contract.
 *
 * Documentation-only checks (no database):
 *  - `GET /mobile/upcoming-shifts` is published with the exact operationId
 *    `getMobileUpcomingShifts` under the `Mobile Execution` tag;
 *  - it is an authentication-only self-service read (no
 *    `x-required-permission`, no `x-building-scoped` claim) — the same
 *    posture as `getMobileCurrentShift` — with bearer security and the
 *    400/401 responses documented;
 *  - the optional `dateFrom` / `dateTo` query parameters are documented;
 *  - the published operation is actually registered in the
 *    `mobile-current-shift` router (no invented endpoint);
 *  - no duplicate operationId exists anywhere in the spec;
 *  - no `/mobile/{domain}` duplicate facade was created;
 *  - the response schemas reuse the authoritative roster-row shape and carry
 *    no client-generated id fields;
 *  - the BE-25M current-shift contract stays published (regression);
 *  - unauthenticated calls are rejected by auth middleware (401, never 404).
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const ROUTES_PATH = resolve(
  __dirname,
  '../src/modules/mobile-current-shift/mobile-current-shift.routes.ts',
);
const API_PREFIX = '/api/v1';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

function allOperations(): Array<{ path: string; method: string; op: any }> {
  const out: Array<{ path: string; method: string; op: any }> = [];
  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      out.push({ path, method, op });
    }
  }
  return out;
}

describe('CR-BE-MOB-05 PART 01 — mobile upcoming shifts contract', () => {
  it('publishes GET /mobile/upcoming-shifts with the exact operationId and tag', () => {
    const op = spec.paths?.['/mobile/upcoming-shifts']?.get;
    assert.ok(op, 'GET /mobile/upcoming-shifts must exist in OpenAPI');
    assert.equal(op.operationId, 'getMobileUpcomingShifts');
    assert.deepEqual(op.tags ?? [], ['Mobile Execution']);
    assert.ok(
      (spec.tags ?? []).some((t: { name: string }) => t.name === 'Mobile Execution'),
      'the Mobile Execution tag must be declared',
    );
  });

  it('is authentication-only self-service (no permission, no building-scope claim)', () => {
    const op = spec.paths['/mobile/upcoming-shifts'].get;
    assert.equal(
      op['x-required-permission'],
      undefined,
      'upcoming-shifts must not require a permission code (self-service)',
    );
    assert.notEqual(
      op['x-building-scoped'],
      true,
      'upcoming-shifts must not claim x-building-scoped (self-service, like current-shift)',
    );
    const hasBearer = (op.security ?? []).some(
      (s: Record<string, unknown>) => 'bearerAuth' in s,
    );
    assert.ok(hasBearer, 'bearer security required');
    assert.ok(op.responses?.['401'], '401 must be documented');
    assert.ok(op.responses?.['400'], '400 (query validation) must be documented');
  });

  it('documents the optional dateFrom/dateTo query parameters', () => {
    const op = spec.paths['/mobile/upcoming-shifts'].get;
    const params = (op.parameters ?? []).map((p: any) => p.name);
    assert.ok(params.includes('dateFrom'), 'dateFrom must be documented');
    assert.ok(params.includes('dateTo'), 'dateTo must be documented');
    for (const name of ['dateFrom', 'dateTo']) {
      const param = (op.parameters ?? []).find((p: any) => p.name === name);
      assert.equal(param.in, 'query');
      assert.equal(param.required, false);
    }
  });

  it('is registered in the mobile-current-shift router (no invented endpoint)', () => {
    const source = readFileSync(ROUTES_PATH, 'utf8');
    assert.match(
      source,
      /\.get\(\s*'\/mobile\/upcoming-shifts'/,
      'the router must register GET /mobile/upcoming-shifts',
    );
    const op = spec.paths['/mobile/upcoming-shifts'].get;
    const duplicates = allOperations().filter(
      ({ op: candidate }) =>
        candidate.operationId === 'getMobileUpcomingShifts' &&
        candidate !== op,
    );
    assert.deepEqual(duplicates, [], 'no duplicate operationId may exist');
  });

  it('adds no /mobile/{domain} duplicate facade', () => {
    const facade = /\/mobile\/(housekeeping|security|engineering|material|inventory|work-order|patrol|incident|push-send)/;
    const offenders = Object.keys(spec.paths ?? {}).filter((p) =>
      facade.test(p),
    );
    assert.deepEqual(offenders, []);
  });

  it('reuses the authoritative roster-row schema with no invented ids', () => {
    const item = spec.components.schemas.MobileUpcomingShift;
    assert.ok(item, 'MobileUpcomingShift schema must exist');
    assert.equal(
      item.allOf?.[0]?.$ref,
      '#/components/schemas/MobileCurrentShift',
      'MobileUpcomingShift must reuse the MobileCurrentShift roster-row shape',
    );

    const context = spec.components.schemas.MobileUpcomingShiftsContext;
    assert.ok(context, 'MobileUpcomingShiftsContext schema must exist');
    assert.deepEqual(context.required, ['asOf', 'dateFrom', 'dateTo', 'shifts']);
    assert.equal(
      context.properties.shifts.items.$ref,
      '#/components/schemas/MobileUpcomingShift',
    );
    assert.equal(context.properties.dateTo.nullable, true);

    const banned = /^(localId|tempId|clientId_local|clientGeneratedId|offlineId|fakeId|mockId)$/;
    const offenders: string[] = [];
    for (const schema of [item, context]) {
      for (const property of Object.keys(schema.properties ?? {})) {
        if (banned.test(property)) offenders.push(property);
      }
    }
    assert.deepEqual(offenders, [], 'no client-generated id field may exist');
  });

  it('keeps the BE-25M current-shift contract published (regression)', () => {
    const op = spec.paths?.['/mobile/current-shift']?.get;
    assert.ok(op, 'getMobileCurrentShift must stay published');
    assert.equal(op.operationId, 'getMobileCurrentShift');
  });

  it('rejects unauthenticated requests with 401, never 404', async () => {
    const request = api();
    const response = await request.get(`${API_PREFIX}/mobile/upcoming-shifts`);
    assert.notEqual(response.status, 404, 'route must be registered');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');

    // Authentication runs before query validation: even a malformed query
    // is 401 when unauthenticated (never a 404, never a 400 leak).
    const bad = await request.get(
      `${API_PREFIX}/mobile/upcoming-shifts?dateFrom=not-a-date`,
    );
    assert.equal(bad.status, 401);
  });
});
