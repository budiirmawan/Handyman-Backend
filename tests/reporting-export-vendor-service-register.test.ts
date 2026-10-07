import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReportingCsv } from '../src/modules/reporting-export/csv-renderer';
import { getReportingExportDatasetAdapter } from '../src/modules/reporting-export/reporting-export.registry';
import { projectVendorServiceRegister } from '../src/modules/reporting-export/reporting-export.projections';
import type { PublicReportingExport } from '../src/modules/reporting-export/reporting-export.types';
import { parseReportingExportQuery } from '../src/modules/reporting-export/reporting-export.validation';
import type {
  PublicVendorServiceRegister,
  PublicVendorServiceRegisterRow,
} from '../src/modules/vendor-service-register';

/**
 * R01 PART 01 RETRY — VENDOR_SERVICE_REGISTER dataset focused validation.
 *
 * No database: the adapter delegates loading to the backend-owned read
 * contract (live integration belongs to CI/dev), so this file proves the
 * Reporting-owned surface only —
 *   - dataset registration resolves with the governed adapter contract
 *   - the export query parser accepts the dataset and passes filters through
 *   - the projection copies read-contract rows verbatim (nulls preserved,
 *     no derived values, no KPI arithmetic)
 *   - the existing CSV renderer pipeline serializes the projected table
 */

function fullRow(): PublicVendorServiceRegisterRow {
  return {
    vendorWorkId: '11111111-1111-1111-1111-111111111111',
    vendorAssignmentId: '22222222-2222-2222-2222-222222222222',
    assignedAt: '2026-09-01T00:00:00.000Z',
    vendorId: '33333333-3333-3333-3333-333333333333',
    vendorCode: 'VND_ACME',
    vendorName: 'Acme Services',
    workOrderId: '44444444-4444-4444-4444-444444444444',
    workOrderNumber: 'WO-001',
    workOrderStatus: 'IN_PROGRESS',
    functionalLocationId: '55555555-5555-5555-5555-555555555555',
    assetId: '66666666-6666-6666-6666-666666666666',
    assetCode: 'AST-001',
    assetName: 'Genset 1',
    vendorWorkStatus: 'COMPLETED',
    vendorWorkStartedAt: '2026-09-02T00:00:00.000Z',
    vendorWorkCompletedAt: '2026-09-03T00:00:00.000Z',
    checklistBindingCount: 2,
    completionReportId: '77777777-7777-7777-7777-777777777777',
    completionReportStatus: 'SUBMITTED',
    completionSubmittedAt: '2026-09-03T01:00:00.000Z',
    serviceReportId: '88888888-8888-8888-8888-888888888888',
    serviceReportNumber: 'SRV-001',
    serviceReportStatus: 'FINALIZED',
    serviceReportDate: '2026-09-03',
    serviceReportFinalizedAt: '2026-09-04T00:00:00.000Z',
    verificationReviewId: '99999999-9999-9999-9999-999999999999',
    verificationDecision: 'APPROVED',
    verificationReviewedAt: '2026-09-05T00:00:00.000Z',
    reworkCount: 1,
    latestReworkId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    latestReworkStatus: 'RESUBMITTED',
    bastBindingId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    bastNumber: 'BAST-001',
    bastDate: '2026-09-06',
    bastAcceptanceStatus: 'ACCEPTED',
    bastSubmittedAt: '2026-09-05T01:00:00.000Z',
    bastAcceptedAt: '2026-09-06T01:00:00.000Z',
    canonicalBastDocumentId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    canonicalBastAcceptanceStatus: 'ACCEPTED',
    buildingId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    clientId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  };
}

function bareRow(): PublicVendorServiceRegisterRow {
  return {
    ...fullRow(),
    vendorWorkId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    functionalLocationId: null,
    assetId: null,
    assetCode: null,
    assetName: null,
    vendorWorkStatus: 'IN_PROGRESS',
    vendorWorkStartedAt: '2026-09-02T00:00:00.000Z',
    vendorWorkCompletedAt: null,
    checklistBindingCount: 0,
    completionReportId: null,
    completionReportStatus: null,
    completionSubmittedAt: null,
    serviceReportId: null,
    serviceReportNumber: null,
    serviceReportStatus: null,
    serviceReportDate: null,
    serviceReportFinalizedAt: null,
    verificationReviewId: null,
    verificationDecision: null,
    verificationReviewedAt: null,
    reworkCount: 0,
    latestReworkId: null,
    latestReworkStatus: null,
    bastBindingId: null,
    bastNumber: null,
    bastDate: null,
    bastAcceptanceStatus: null,
    bastSubmittedAt: null,
    bastAcceptedAt: null,
    canonicalBastDocumentId: null,
    canonicalBastAcceptanceStatus: null,
  };
}

function source(): PublicVendorServiceRegister {
  return {
    buildingId: null,
    buildingScope: ['dddddddd-dddd-dddd-dddd-dddddddddddd'],
    dateFrom: '2026-09-01',
    dateTo: '2026-09-11',
    asOf: '2026-09-11T00:00:00.000Z',
    rows: [fullRow(), bareRow()],
  };
}

test('resolves the VENDOR_SERVICE_REGISTER adapter with the governed contract', () => {
  const adapter = getReportingExportDatasetAdapter('VENDOR_SERVICE_REGISTER');

  assert.equal(adapter.dataset, 'VENDOR_SERVICE_REGISTER');
  assert.equal(adapter.datasetLabel, 'Vendor Service Register');
  assert.equal(
    adapter.sourceAuthority,
    'CR-BE-REPORT-READ-01 vendor-service-register',
  );
  // Reused existing vendor-reporting read permission; no new permission.
  assert.equal(adapter.requiredReadPermission, 'vendor_tenant_kpi.read');
  assert.equal(typeof adapter.load, 'function');
});

test('accepts the dataset at the export query parser with pass-through filters', () => {
  const filters = parseReportingExportQuery({
    dataset: 'VENDOR_SERVICE_REGISTER',
    buildingId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    vendorId: '33333333-3333-3333-3333-333333333333',
    verificationDecision: 'APPROVED',
    dateFrom: '2026-09-01',
    dateTo: '2026-09-11',
  });

  assert.equal(filters.dataset, 'VENDOR_SERVICE_REGISTER');
  assert.equal(filters.buildingId, 'dddddddd-dddd-dddd-dddd-dddddddddddd');
  assert.equal(filters.dateFrom, '2026-09-01');
  assert.equal(filters.dateTo, '2026-09-11');
  assert.equal(
    filters.passThrough.vendorId,
    '33333333-3333-3333-3333-333333333333',
  );
  assert.equal(filters.passThrough.verificationDecision, 'APPROVED');
});

test('projects register rows verbatim without derived values', () => {
  const projected = projectVendorServiceRegister(source());

  // A register carries no headline figures; nothing is calculated.
  assert.deepEqual(projected.kpis, []);
  assert.equal(projected.tables.length, 1);

  const [register] = projected.tables;
  assert.equal(register.key, 'vendorServiceRegister');
  assert.equal(register.rowCount, 2);
  assert.equal(register.rows.length, 2);

  // Every read-contract field is exposed exactly once, in contract order.
  assert.deepEqual(
    register.columns.map((column) => column.key),
    Object.keys(fullRow()),
  );

  // Full row: values copied verbatim.
  const [first] = register.rows;
  assert.equal(first.vendorCode, 'VND_ACME');
  assert.equal(first.workOrderStatus, 'IN_PROGRESS');
  assert.equal(first.vendorWorkStatus, 'COMPLETED');
  assert.equal(first.checklistBindingCount, 2);
  assert.equal(first.verificationDecision, 'APPROVED');
  assert.equal(first.reworkCount, 1);
  assert.equal(first.bastAcceptanceStatus, 'ACCEPTED');
  assert.equal(
    first.canonicalBastAcceptanceStatus,
    'ACCEPTED',
  );

  // Bare row: missing links stay null; counts stay numeric zero.
  const [, second] = register.rows;
  assert.equal(second.assetId, null);
  assert.equal(second.completionReportStatus, null);
  assert.equal(second.verificationDecision, null);
  assert.equal(second.bastAcceptanceStatus, null);
  assert.equal(second.checklistBindingCount, 0);
  assert.equal(second.reworkCount, 0);
  assert.equal(second.vendorWorkStatus, 'IN_PROGRESS');
});

test('serializes the projected register through the existing CSV renderer', () => {
  const projected = projectVendorServiceRegister(source());
  const envelope: PublicReportingExport = {
    metadata: {
      dataset: 'VENDOR_SERVICE_REGISTER',
      datasetLabel: 'Vendor Service Register',
      buildingId: null,
      buildingScope: source().buildingScope,
      period: { dateFrom: '2026-09-01', dateTo: '2026-09-11' },
      filters: {},
      asOf: '2026-09-11T00:00:00.000Z',
    },
    kpis: projected.kpis,
    tables: projected.tables,
    generatedAt: '2026-09-11T00:00:01.000Z',
  };

  const csv = renderReportingCsv(envelope);

  assert.equal(csv.contentType, 'text/csv; charset=utf-8');
  assert.ok(csv.bytes.length > 0);
  assert.match(csv.text, /Vendor Code,.*Vendor Work Status/u);
  assert.match(csv.text, /VND_ACME/u);
  assert.match(csv.text, /COMPLETED/u);
  // Bare row renders with empty cells (two rows + header = three lines).
  assert.equal(csv.text.split('\r\n').length, 4);
});
