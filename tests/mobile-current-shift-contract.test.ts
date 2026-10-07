import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

/**
 * MOB-C03 PART 01 / PART 03B — Current / Upcoming Shift mobile contract alignment
 * (OpenAPI contract layer; DB-free).
 *
 * Pins that the authoritative machine contract (`docs/api/openapi.yaml`)
 * publishes the shift read models exactly as the runtime emits them
 * (`src/modules/mobile-current-shift`), while preserving:
 *   - bearer-only self-service auth on both endpoints (401, not 403);
 *   - the roster-row DTO shape and the backend-derived authoritative ids;
 *   - MOB-C03 PART 03B: the nullable securityPost summary field on shift items;
 *   - no invented client "active shift" boolean / state;
 *   - the documented empty (not-on-shift) behaviour.
 *
 * The live derivation (timezone/window, assignment removed/inactive,
 * scope removal) is covered by the embedded-Postgres tests in
 * tests/mobile-current-shift.test.ts and tests/mobile-upcoming-shifts.test.ts.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const ROUTER_PATH = resolve(
  __dirname,
  '../src/modules/mobile-current-shift/mobile-current-shift.routes.ts',
);

function loadSpec(): Record<string, any> {
  const doc = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;
  assert.ok(doc && typeof doc === 'object', 'openapi.yaml must parse as YAML');
  return doc;
}

describe('MOB-C03 PART 01 — current/upcoming shift OpenAPI contract', () => {
  const spec = loadSpec();
  const schemas = spec.components?.schemas ?? {};

  it('publishes /mobile/current-shift and /mobile/upcoming-shifts, bearer-only with 401 (no 403)', () => {
    const current = spec.paths?.['/mobile/current-shift']?.get;
    const upcoming = spec.paths?.['/mobile/upcoming-shifts']?.get;
    assert.ok(current, 'GET /mobile/current-shift must be documented');
    assert.ok(upcoming, 'GET /mobile/upcoming-shifts must be documented');
    assert.equal(current.operationId, 'getMobileCurrentShift');
    assert.equal(upcoming.operationId, 'getMobileUpcomingShifts');

    for (const op of [current, upcoming]) {
      assert.ok(
        Array.isArray(op.security) &&
          op.security.some((s: Record<string, unknown>) => 'bearerAuth' in s),
        'shift self-service endpoints must require bearerAuth',
      );
      assert.ok(op.responses['401'], 'must document 401');
      assert.ok(
        !op.responses['403'],
        'self-service shift reads derive scope internally and must not document a 403',
      );
    }
    // Upcoming additionally documents the 400 validation response.
    assert.ok(upcoming.responses['400'], 'upcoming-shifts must document 400 for bad window params');
  });

  it('MobileCurrentShift matches the runtime roster-row DTO (exact field set)', () => {
    const shift = schemas.MobileCurrentShift;
    assert.ok(shift, 'MobileCurrentShift schema required');
    assert.deepEqual(
      [...shift.required].sort(),
      [
        'assignmentId', 'buildingCode', 'buildingId', 'buildingName', 'clientId',
        'code', 'effectiveFrom', 'effectiveUntil', 'employeeCode', 'endTime',
        'name', 'securityPost', 'shiftId', 'startTime', 'status', 'workforceProfileId',
      ].sort(),
    );
    // Authoritative ids are uuid references; no client-supplied/invented ids.
    for (const idField of ['assignmentId', 'shiftId', 'workforceProfileId', 'clientId', 'buildingId']) {
      assert.equal(
        shift.properties[idField].$ref,
        '#/components/schemas/Uuid',
        `${idField} must be a uuid`,
      );
    }
    // Wall-clock times are strings (HH:MM:SS), not date-time; only the roster
    // effective window is a nullable date-time.
    assert.equal(shift.properties.startTime.type, 'string');
    assert.ok(
      !shift.properties.startTime.format,
      'startTime is a wall-clock time, not a date-time',
    );
    assert.equal(shift.properties.endTime.type, 'string');
    assert.equal(shift.properties.effectiveFrom.format, 'date-time');
    assert.equal(shift.properties.effectiveFrom.nullable, true);
    assert.equal(shift.properties.effectiveUntil.format, 'date-time');
    assert.equal(shift.properties.effectiveUntil.nullable, true);
  });

  it('advertises securityPost nullable summary (MOB-C03 PART 03B)', () => {
    const shift = schemas.MobileCurrentShift;
    assert.ok(shift, 'MobileCurrentShift schema required');

    // securityPost must be present and required on the shift item
    assert.ok(shift.required.includes('securityPost'), 'securityPost must be required on MobileCurrentShift');

    // securityPost must be nullable and reference MobileSecurityPostSummary
    const securityPostProp = shift.properties.securityPost;
    assert.ok(securityPostProp, 'securityPost property must exist');
    assert.equal(securityPostProp.nullable, true, 'securityPost must be nullable');

    // Check it references MobileSecurityPostSummary
    const allOf = securityPostProp.allOf;
    assert.ok(Array.isArray(allOf) && allOf.length > 0, 'securityPost must use allOf');
    const ref = allOf[0].$ref;
    assert.equal(ref, '#/components/schemas/MobileSecurityPostSummary', 'securityPost must reference MobileSecurityPostSummary');

    // MobileSecurityPostSummary must exist with exactly id, code, name
    const summary = schemas.MobileSecurityPostSummary;
    assert.ok(summary, 'MobileSecurityPostSummary schema required');
    assert.deepEqual([...summary.required].sort(), ['id', 'code', 'name'].sort());
    assert.ok(summary.properties.id.$ref === '#/components/schemas/Uuid');
    assert.equal(summary.properties.code.type, 'string');
    assert.equal(summary.properties.name.type, 'string');

    // Verify forbidden invented fields are still absent
    const forbidden = [
      'securityPostId',
      'postAssignmentId',
      'currentPost',
      'eligiblePosts',
      'postId',
    ];
    for (const bad of forbidden) {
      assert.ok(
        !shift.properties[bad],
        `MobileCurrentShift must not declare property ${bad}`,
      );
    }
  });

  it('invents no client "active shift" boolean — presence in shifts[] is the authority', () => {
    const shiftText = JSON.stringify(schemas.MobileCurrentShift.properties);
    const context = schemas.MobileCurrentShiftContext;
    for (const forbidden of ['onShift', 'isActive', 'activeShift', 'currentlyActive']) {
      assert.ok(!shiftText.includes(forbidden), `shift item must not carry ${forbidden}`);
      assert.ok(
        !Object.keys(context.properties).includes(forbidden),
        `context must not carry ${forbidden}`,
      );
    }
    assert.deepEqual([...context.required].sort(), ['asOf', 'shifts']);
    const shiftsProp = context.properties.shifts;
    assert.equal(shiftsProp.type, 'array');
    assert.match(shiftsProp.description ?? '', /not on shift|empty/i);
  });

  it('upcoming-shifts context matches the runtime shape and reuses the roster-row item', () => {
    const upcoming = schemas.MobileUpcomingShiftsContext;
    assert.ok(upcoming, 'MobileUpcomingShiftsContext required');
    assert.deepEqual(
      [...upcoming.required].sort(),
      ['asOf', 'dateFrom', 'dateTo', 'shifts'],
    );
    assert.equal(upcoming.properties.dateTo.nullable, true);
    assert.equal(upcoming.properties.dateFrom.format, 'date-time');
    assert.equal(upcoming.properties.shifts.items.$ref, '#/components/schemas/MobileUpcomingShift');
    // MobileUpcomingShift is the same roster-row shape (allOf MobileCurrentShift).
    const item = schemas.MobileUpcomingShift;
    assert.equal(item.allOf[0].$ref, '#/components/schemas/MobileCurrentShift');

    // The endpoint documents the optional window query parameters.
    const params = spec.paths['/mobile/upcoming-shifts'].get.parameters ?? [];
    const names = params.map((p: any) => p.name).sort();
    assert.deepEqual(names, ['dateFrom', 'dateTo']);
  });

  it('both endpoints are registered in the mobile-current-shift router (no invented path)', () => {
    const routerSrc = readFileSync(ROUTER_PATH, 'utf8');
    assert.match(routerSrc, /\/mobile\/current-shift/);
    assert.match(routerSrc, /\/mobile\/upcoming-shifts/);
    assert.match(routerSrc, /authenticationMiddleware/);
  });
});
