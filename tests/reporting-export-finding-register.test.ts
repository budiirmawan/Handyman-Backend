import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReportingCsv } from '../src/modules/reporting-export/csv-renderer';
import { getReportingExportDatasetAdapter } from '../src/modules/reporting-export/reporting-export.registry';
import { projectFindingRegister } from '../src/modules/reporting-export/reporting-export.projections';
import type { PublicReportingExport } from '../src/modules/reporting-export/reporting-export.types';
import { parseReportingExportQuery } from '../src/modules/reporting-export/reporting-export.validation';
import type {
  PublicFindingRegister,
  PublicFindingRegisterRow,
} from '../src/modules/finding-register';

/**
 * R02 PART 01 RETRY — FINDING_REGISTER dataset focused validation.
 *
 * No database: the adapter delegates loading to the backend-owned
 * finding-register read contract (live integration belongs to CI/dev),
 * so this file proves the Reporting-owned surface only —
 *   - dataset registration resolves with the governed adapter contract
 *   - the export query parser accepts the dataset and passes filters
 *     through untouched to the module-owned parser
 *   - the projection copies read-contract rows verbatim (nulls preserved,
 *     no derived values, no KPI arithmetic, booleans flattened to
 *     'true'/'false' strings for CSV compatibility)
 *   - the existing CSV renderer pipeline serializes the projected table
 */

function fullRow(): PublicFindingRegisterRow {
  return {
    findingId: '11111111-1111-1111-1111-111111111111',
    findingNumber: 'FND-0001',
    title: 'Exposed wiring on chiller',
    description: 'High-voltage wiring exposed on panel.',
    status: 'CLOSED',
    classificationId: '22222222-2222-2222-2222-222222222222',
    classificationCode: 'CLS_ELEC',
    classificationName: 'Safety / Electrical',
    severityId: '33333333-3333-3333-3333-333333333333',
    severityCode: 'SEV_CRIT',
    severityName: 'Critical',
    severityRank: 1,
    sourceType: 'WORK_ORDER',
    sourceId: '44444444-4444-4444-4444-444444444444',
    sourceReferenceNumber: 'WO-001',
    clientId: '55555555-5555-5555-5555-555555555555',
    buildingId: '66666666-6666-6666-6666-666666666666',
    assetId: '77777777-7777-7777-7777-777777777777',
    functionalLocationId: '88888888-8888-8888-8888-888888888888',
    reportedByUserId: '99999999-9999-9999-9999-999999999999',
    reportedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:05:00.000Z',
    stateChangedAt: '2026-09-05T00:00:00.000Z',
    assigneeType: 'WORKFORCE',
    assignedWorkforceProfileId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    assignedTeamId: null,
    assignedVendorId: null,
    assignedByUserId: '99999999-9999-9999-9999-999999999999',
    assignedAt: '2026-09-02T00:00:00.000Z',
    evidenceCount: 2,
    reworkCount: 1,
    latestReworkId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    latestReworkStatus: 'REQUESTED',
    latestReworkRequestedAt: '2026-09-04T00:00:00.000Z',
    verificationReviewId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    verificationReviewStatus: 'COMPLETED',
    verificationDecision: 'APPROVED',
    verificationReviewerUserId: '99999999-9999-9999-9999-999999999999',
    verificationReviewedAt: '2026-09-05T00:00:00.000Z',
    closedAt: '2026-09-05T01:00:00.000Z',
    closedByUserId: '99999999-9999-9999-9999-999999999999',
    closureNotes: 'Closed after verification.',
    historyAvailable: true,
    historyCount: 3,
  };
}

function bareRow(): PublicFindingRegisterRow {
  return {
    findingId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    findingNumber: 'FND-0002',
    title: 'Bare open finding',
    description: null,
    status: 'OPEN',
    classificationId: null,
    classificationCode: null,
    classificationName: null,
    severityId: null,
    severityCode: null,
    severityName: null,
    severityRank: null,
    sourceType: null,
    sourceId: null,
    sourceReferenceNumber: null,
    clientId: '55555555-5555-5555-5555-555555555555',
    buildingId: '66666666-6666-6666-6666-666666666666',
    assetId: null,
    functionalLocationId: null,
    reportedByUserId: '99999999-9999-9999-9999-999999999999',
    reportedAt: '2026-09-03T00:00:00.000Z',
    createdAt: '2026-09-03T00:00:00.000Z',
    stateChangedAt: '2026-09-03T00:00:00.000Z',
    assigneeType: null,
    assignedWorkforceProfileId: null,
    assignedTeamId: null,
    assignedVendorId: null,
    assignedByUserId: null,
    assignedAt: null,
    evidenceCount: 0,
    reworkCount: 0,
    latestReworkId: null,
    latestReworkStatus: null,
    latestReworkRequestedAt: null,
    verificationReviewId: null,
    verificationReviewStatus: null,
    verificationDecision: null,
    verificationReviewerUserId: null,
    verificationReviewedAt: null,
    closedAt: null,
    closedByUserId: null,
    closureNotes: null,
    historyAvailable: false,
    historyCount: 0,
  };
}

function source(): PublicFindingRegister {
  return {
    buildingId: null,
    buildingScope: ['66666666-6666-6666-6666-666666666666'],
    dateFrom: '2026-09-01',
    dateTo: '2026-09-11',
    asOf: '2026-09-11T00:00:00.000Z',
    rows: [fullRow(), bareRow()],
  };
}

test('resolves the FINDING_REGISTER adapter with the governed contract', () => {
  const adapter = getReportingExportDatasetAdapter('FINDING_REGISTER');

  assert.equal(adapter.dataset, 'FINDING_REGISTER');
  assert.equal(adapter.datasetLabel, 'Finding Register');
  assert.equal(
    adapter.sourceAuthority,
    'CR-BE-REPORT-READ-02 finding-register',
  );
  // Reuses the closest existing governed finding read permission; no new
  // permission, no RBAC migration.
  assert.equal(adapter.requiredReadPermission, 'finding.read');
  assert.equal(typeof adapter.load, 'function');
});

test('accepts the dataset at the export query parser with pass-through filters', () => {
  const filters = parseReportingExportQuery({
    dataset: 'FINDING_REGISTER',
    buildingId: '66666666-6666-6666-6666-666666666666',
    status: 'CLOSED',
    severityId: '33333333-3333-3333-3333-333333333333',
    classificationId: '22222222-2222-2222-2222-222222222222',
    sourceType: 'WORK_ORDER',
    assignedUserId: '99999999-9999-9999-9999-999999999999',
    verificationDecision: 'APPROVED',
    dateFrom: '2026-09-01',
    dateTo: '2026-09-11',
  });

  assert.equal(filters.dataset, 'FINDING_REGISTER');
  assert.equal(filters.buildingId, '66666666-6666-6666-6666-666666666666');
  assert.equal(filters.dateFrom, '2026-09-01');
  assert.equal(filters.dateTo, '2026-09-11');
  assert.equal(filters.passThrough.status, 'CLOSED');
  assert.equal(
    filters.passThrough.severityId,
    '33333333-3333-3333-3333-333333333333',
  );
  assert.equal(
    filters.passThrough.classificationId,
    '22222222-2222-2222-2222-222222222222',
  );
  assert.equal(filters.passThrough.sourceType, 'WORK_ORDER');
  assert.equal(
    filters.passThrough.assignedUserId,
    '99999999-9999-9999-9999-999999999999',
  );
  assert.equal(filters.passThrough.verificationDecision, 'APPROVED');
});

test('projects register rows verbatim without derived values', () => {
  const projected = projectFindingRegister(source());

  // A register carries no headline figures; nothing is calculated.
  assert.deepEqual(projected.kpis, []);
  assert.equal(projected.tables.length, 1);

  const [register] = projected.tables;
  assert.equal(register.key, 'findingRegister');
  assert.equal(register.label, 'Finding Register');
  assert.equal(register.rowCount, 2);
  assert.equal(register.rows.length, 2);

  // Column keys match the public row contract keys (order reflects the
  // column-definition list, which follows the spec grouping).
  const columnKeys = register.columns.map((c) => c.key);
  for (const k of Object.keys(fullRow())) {
    assert.ok(columnKeys.includes(k), `column ${k} must be projected`);
  }

  // Full row: values copied verbatim.
  const [first] = register.rows;
  assert.equal(first.findingNumber, 'FND-0001');
  assert.equal(first.status, 'CLOSED');
  assert.equal(first.classificationCode, 'CLS_ELEC');
  assert.equal(first.severityRank, 1);
  assert.equal(first.sourceType, 'WORK_ORDER');
  assert.equal(first.sourceReferenceNumber, 'WO-001');
  assert.equal(first.assigneeType, 'WORKFORCE');
  assert.equal(first.evidenceCount, 2);
  assert.equal(first.reworkCount, 1);
  assert.equal(first.latestReworkStatus, 'REQUESTED');
  assert.equal(first.verificationReviewStatus, 'COMPLETED');
  assert.equal(first.verificationDecision, 'APPROVED');
  assert.equal(first.closedByUserId, '99999999-9999-9999-9999-999999999999');
  assert.equal(first.closureNotes, 'Closed after verification.');
  // Boolean flattened to STRING for CSV safety.
  assert.equal(first.historyAvailable, 'true');
  assert.equal(first.historyCount, 3);

  // Bare row: missing links stay null; numeric zero stays zero.
  const [, second] = register.rows;
  assert.equal(second.status, 'OPEN');
  assert.equal(second.classificationId, null);
  assert.equal(second.severityId, null);
  assert.equal(second.sourceType, null);
  assert.equal(second.sourceId, null);
  assert.equal(second.assetId, null);
  assert.equal(second.functionalLocationId, null);
  assert.equal(second.assigneeType, null);
  assert.equal(second.evidenceCount, 0);
  assert.equal(second.reworkCount, 0);
  assert.equal(second.latestReworkId, null);
  assert.equal(second.verificationReviewId, null);
  assert.equal(second.closedAt, null);
  assert.equal(second.historyAvailable, 'false');
  assert.equal(second.historyCount, 0);
});

test('serializes the projected register through the existing CSV renderer', () => {
  const projected = projectFindingRegister(source());
  const envelope: PublicReportingExport = {
    metadata: {
      dataset: 'FINDING_REGISTER',
      datasetLabel: 'Finding Register',
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
  assert.match(csv.text, /Finding No,.*Status/u);
  assert.match(csv.text, /FND-0001/u);
  assert.match(csv.text, /CLOSED/u);
  assert.match(csv.text, /APPROVED/u);
  // Bare row renders with empty cells (two rows + header = three lines).
  assert.equal(csv.text.split('\r\n').length, 4);
});
