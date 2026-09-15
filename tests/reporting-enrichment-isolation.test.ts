import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

/**
 * FIX-01 focused static regression coverage.
 *
 * Runtime database cases are CI-required when dependencies/database are
 * available. These assertions pin the actual repository SQL so an ID-only
 * enrichment/correlation join cannot be reintroduced.
 */

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

function between(value: string, start: string, end: string): string {
  const startAt = value.indexOf(start);
  assert.notEqual(startAt, -1, `missing section start: ${start}`);
  const endAt = value.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `missing section end: ${end}`);
  return value.slice(startAt, endAt);
}

const finding = source('src/modules/finding-register/finding-register.repository.ts');
const findingJoin = between(
  finding,
  'LEFT JOIN work_orders wo',
  'LEFT JOIN LATERAL (',
);
const workOrder = source('src/modules/work-order-register/work-order-register.repository.ts');
const findingCount = between(
  workOrder,
  'SELECT count(*)::int AS finding_count',
  ') fn ON TRUE',
);
const vendor = source('src/modules/vendor-service-register/vendor-service-register.repository.ts');
const vendorJoin = between(
  vendor,
  'LEFT JOIN work_orders wo',
  'LEFT JOIN assets a',
);


test('Finding Register enriches only a same-context Work Order', () => {
  assert.match(finding, /FROM findings f/);
  assert.match(finding, /wo\.work_order_number AS source_reference_number/);
  assert.match(finding, /wo\.asset_id AS asset_id/);
  assert.match(finding, /wo\.functional_location_id AS functional_location_id/);
  assert.match(findingJoin, /wo\.id = f\.source_id/);
  assert.match(findingJoin, /f\.source_type = 'WORK_ORDER'/);
  assert.match(findingJoin, /wo\.client_id = f\.client_id/);
  assert.match(findingJoin, /wo\.building_id = f\.building_id/);
});

test('Finding Register blocks a cross-client Work Order reference', () => {
  assert.match(findingJoin, /AND wo\.client_id = f\.client_id/);
  assert.doesNotMatch(
    findingJoin,
    /ON wo\.id = f\.source_id AND f\.source_type = 'WORK_ORDER'\s*$/,
  );
});

test('Finding Register blocks a cross-building Work Order reference', () => {
  assert.match(findingJoin, /AND wo\.building_id = f\.building_id/);
});

test('Finding Register preserves the authorized Finding row on malformed enrichment', () => {
  assert.match(findingJoin, /^LEFT JOIN work_orders wo/);
  assert.match(finding, /FROM findings f/);
});

test('Work Order finding count keeps source type and same-context correlation', () => {
  assert.match(findingCount, /f\.source_type = 'WORK_ORDER'/);
  assert.match(findingCount, /f\.source_id = wo\.id/);
  assert.match(findingCount, /f\.client_id = wo\.client_id/);
  assert.match(findingCount, /f\.building_id = wo\.building_id/);
});

test('Work Order finding count excludes a cross-client Finding', () => {
  assert.match(findingCount, /AND f\.client_id = wo\.client_id/);
});

test('Work Order finding count excludes a cross-building Finding', () => {
  assert.match(findingCount, /AND f\.building_id = wo\.building_id/);
});

test('Vendor Service Register preserves the vendor row and enriches same context', () => {
  assert.match(vendor, /FROM vendor_works vw/);
  assert.match(vendor, /wo\.id AS work_order_id/);
  assert.match(vendor, /wo\.work_order_number AS work_order_number/);
  assert.match(vendor, /wo\.status AS work_order_status/);
  assert.match(vendorJoin, /^LEFT JOIN work_orders wo/);
  assert.match(vendorJoin, /wo\.id = vw\.work_order_id/);
  assert.match(vendorJoin, /wo\.client_id = v\.client_id/);
  assert.match(vendorJoin, /wo\.building_id = vw\.building_id/);
});

test('Vendor Service Register blocks a cross-client Work Order', () => {
  assert.match(vendorJoin, /AND wo\.client_id = v\.client_id/);
});

test('Vendor Service Register blocks a cross-building Work Order', () => {
  assert.match(vendorJoin, /AND wo\.building_id = vw\.building_id/);
});
