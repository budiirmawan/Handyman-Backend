import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReportingCsv } from '../src/modules/reporting-export/csv-renderer';
import { getReportingExportDatasetAdapter } from '../src/modules/reporting-export/reporting-export.registry';
import { projectWorkOrderRegister } from '../src/modules/reporting-export/reporting-export.projections';
import type { PublicReportingExport } from '../src/modules/reporting-export/reporting-export.types';
import { parseReportingExportQuery } from '../src/modules/reporting-export/reporting-export.validation';
import type {
  PublicWorkOrderRegister,
  PublicWorkOrderRegisterRow,
} from '../src/modules/work-order-register';

/**
 * R03 PART 01 RETRY — WORK_ORDER_REGISTER dataset focused validation.
 *
 * No database: the adapter delegates loading to the backend-owned
 * work-order-register read contract (live integration belongs to CI/dev).
 * This file proves the Reporting-owned surface only —
 *   - dataset registration resolves with the governed adapter contract
 *   - the export query parser accepts the dataset and passes filters
 *     through untouched to the module-owned parser
 *   - the projection copies read-contract rows verbatim (nulls preserved,
 *     no derived values, no KPI arithmetic, booleans flattened to
 *     'true'/'false' strings for CSV compatibility)
 *   - the existing CSV renderer pipeline serializes the projected table
 *   - no new permission; reuses work_order.read
 */

function fullRow(): PublicWorkOrderRegisterRow {
  return {
    workOrderId: '11111111-1111-1111-1111-111111111111',
    workOrderNumber: 'WO-0001',
    title: 'Chiller repair',
    description: 'Chiller vibrating abnormally.',
    status: 'COMPLETED',
    clientId: '22222222-2222-2222-2222-222222222222',
    buildingId: '33333333-3333-3333-3333-333333333333',
    assetId: '44444444-4444-4444-4444-444444444444',
    assetCode: 'AST-001',
    assetName: 'Chiller 1',
    functionalLocationId: '55555555-5555-5555-5555-555555555555',
    functionalLocationCode: 'FL-CHILLER',
    functionalLocationName: 'Chiller Room',
    workType: 'CORRECTIVE',
    priority: 'HIGH',
    bastRequirement: 'WORK_ORDER',
    workRequestId: '66666666-6666-6666-6666-666666666666',
    createdAt: '2026-09-01T00:00:00.000Z',
    assignedAt: '2026-09-02T00:00:00.000Z',
    startedAt: '2026-09-03T00:00:00.000Z',
    completedAt: '2026-09-05T00:00:00.000Z',
    closedAt: null,
    cancelledAt: null,
    assigneeType: 'WORKFORCE',
    assignedWorkforceProfileId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    assignedTeamId: null,
    assignedVendorId: null,
    assignedByUserId: '77777777-7777-7777-7777-777777777777',
    assignmentAssignedAt: '2026-09-02T00:00:00.000Z',
    evidenceCount: 2,
    findingCount: 3,
    verificationReviewId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    verificationReviewStatus: 'COMPLETED',
    verificationDecision: 'APPROVED',
    verificationReviewerUserId: '77777777-7777-7777-7777-777777777777',
    verificationReviewedAt: '2026-09-05T01:00:00.000Z',
    completedByUserId: '77777777-7777-7777-7777-777777777777',
    completionSummary: 'Work completed.',
    completionNotes: 'Replaced coupling.',
    historyAvailable: true,
    historyCount: 4,
  };
}

function bareRow(): PublicWorkOrderRegisterRow {
  return {
    workOrderId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    workOrderNumber: 'WO-0002',
    title: 'Bare work order',
    description: null,
    status: 'OPEN',
    clientId: '22222222-2222-2222-2222-222222222222',
    buildingId: '33333333-3333-3333-3333-333333333333',
    assetId: null,
    assetCode: null,
    assetName: null,
    functionalLocationId: null,
    functionalLocationCode: null,
    functionalLocationName: null,
    workType: 'PREVENTIVE',
    priority: 'MEDIUM',
    bastRequirement: 'NONE',
    workRequestId: null,
    createdAt: '2026-09-06T00:00:00.000Z',
    assignedAt: null,
    startedAt: null,
    completedAt: null,
    closedAt: null,
    cancelledAt: null,
    assigneeType: null,
    assignedWorkforceProfileId: null,
    assignedTeamId: null,
    assignedVendorId: null,
    assignedByUserId: null,
    assignmentAssignedAt: null,
    evidenceCount: 0,
    findingCount: 0,
    verificationReviewId: null,
    verificationReviewStatus: null,
    verificationDecision: null,
    verificationReviewerUserId: null,
    verificationReviewedAt: null,
    completedByUserId: null,
    completionSummary: null,
    completionNotes: null,
    historyAvailable: false,
    historyCount: 0,
  };
}

function source(): PublicWorkOrderRegister {
  return {
    buildingId: null,
    buildingScope: ['33333333-3333-3333-3333-333333333333'],
    dateFrom: '2026-09-01',
    dateTo: '2026-09-11',
    asOf: '2026-09-11T00:00:00.000Z',
    rows: [fullRow(), bareRow()],
  };
}

test('1. registry resolves WORK_ORDER_REGISTER with the governed contract', () => {
  const adapter = getReportingExportDatasetAdapter('WORK_ORDER_REGISTER');

  assert.equal(adapter.dataset, 'WORK_ORDER_REGISTER');
  assert.equal(adapter.datasetLabel, 'Work Order Register');
  assert.equal(
    adapter.sourceAuthority,
    'CR-BE-REPORT-READ-03 work-order-register',
  );
  assert.equal(adapter.requiredReadPermission, 'work_order.read');
  assert.equal(typeof adapter.load, 'function');
});

test('3. query filters pass through the module-owned parser untouched', () => {
  const filters = parseReportingExportQuery({
    dataset: 'WORK_ORDER_REGISTER',
    buildingId: '33333333-3333-3333-3333-333333333333',
    status: 'COMPLETED',
    workType: 'CORRECTIVE',
    priority: 'HIGH',
    bastRequirement: 'WORK_ORDER',
    assetId: '44444444-4444-4444-4444-444444444444',
    assignedUserId: '77777777-7777-7777-7777-777777777777',
    assignedTeamId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    vendorId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    verificationDecision: 'APPROVED',
    dateFrom: '2026-09-01',
    dateTo: '2026-09-11',
  });

  assert.equal(filters.dataset, 'WORK_ORDER_REGISTER');
  assert.equal(filters.buildingId, '33333333-3333-3333-3333-333333333333');
  assert.equal(filters.dateFrom, '2026-09-01');
  assert.equal(filters.dateTo, '2026-09-11');
  assert.equal(filters.passThrough.status, 'COMPLETED');
  assert.equal(filters.passThrough.workType, 'CORRECTIVE');
  assert.equal(filters.passThrough.priority, 'HIGH');
  assert.equal(filters.passThrough.bastRequirement, 'WORK_ORDER');
  assert.equal(filters.passThrough.assetId, '44444444-4444-4444-4444-444444444444');
  assert.equal(
    filters.passThrough.assignedUserId,
    '77777777-7777-7777-7777-777777777777',
  );
  assert.equal(
    filters.passThrough.assignedTeamId,
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
  );
  assert.equal(
    filters.passThrough.vendorId,
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  );
  assert.equal(filters.passThrough.verificationDecision, 'APPROVED');
});

test('5/6/7/8/9/10. projection exposes rows verbatim, preserves nullables/enums/counts/booleans, kpis empty', () => {
  const projected = projectWorkOrderRegister(source());

  assert.deepEqual(projected.kpis, [], 'register carries no KPIs');
  assert.equal(projected.tables.length, 1);

  const [register] = projected.tables;
  assert.equal(register.key, 'workOrderRegister');
  assert.equal(register.label, 'Work Order Register');
  assert.equal(register.rowCount, 2);
  assert.equal(register.rows.length, 2);

  const columnKeys = register.columns.map((c) => c.key);
  // Every public row field must have a column; no extra reporting-owned fields.
  for (const k of Object.keys(fullRow())) {
    assert.ok(columnKeys.includes(k), `column ${k} must be projected`);
  }
  // Strict field exclusions must NOT appear.
  for (const forbidden of [
    'sourceType',
    'sourceId',
    'scheduledStartAt',
    'scheduledEndAt',
    'dueAt',
    'openFindingCount',
    'reworkCount',
    'closedByUserId',
    'checklistBindingCount',
    'checklistExecutionCount',
    'floorId',
    'areaId',
  ]) {
    assert.ok(!columnKeys.includes(forbidden), `${forbidden} must NOT be projected`);
  }

  // Full row values verbatim — no inference.
  const first = register.rows[0]!;
  assert.equal(first.workOrderNumber, 'WO-0001');
  assert.equal(first.status, 'COMPLETED');
  assert.equal(first.workType, 'CORRECTIVE');
  assert.equal(first.priority, 'HIGH');
  assert.equal(first.bastRequirement, 'WORK_ORDER');
  assert.equal(first.assigneeType, 'WORKFORCE');
  assert.equal(first.verificationReviewStatus, 'COMPLETED');
  assert.equal(first.verificationDecision, 'APPROVED');
  assert.equal(first.evidenceCount, 2);
  assert.equal(first.findingCount, 3);
  assert.equal(first.completionSummary, 'Work completed.');
  assert.equal(first.completionNotes, 'Replaced coupling.');
  assert.equal(first.historyAvailable, 'true');
  assert.equal(first.historyCount, 4);
  assert.equal(first.workRequestId, '66666666-6666-6666-6666-666666666666');

  // Bare row: nulls preserved, zero counts, boolean flattened.
  const second = register.rows[1]!;
  assert.equal(second.status, 'OPEN');
  assert.equal(second.workType, 'PREVENTIVE');
  assert.equal(second.priority, 'MEDIUM');
  assert.equal(second.bastRequirement, 'NONE');
  assert.equal(second.assetId, null);
  assert.equal(second.assetCode, null);
  assert.equal(second.assetName, null);
  assert.equal(second.functionalLocationId, null);
  assert.equal(second.assigneeType, null);
  assert.equal(second.assignedWorkforceProfileId, null);
  assert.equal(second.assignedTeamId, null);
  assert.equal(second.assignedVendorId, null);
  assert.equal(second.verificationReviewId, null);
  assert.equal(second.verificationDecision, null);
  assert.equal(second.completedByUserId, null);
  assert.equal(second.completionSummary, null);
  assert.equal(second.completionNotes, null);
  assert.equal(second.evidenceCount, 0);
  assert.equal(second.findingCount, 0);
  assert.equal(second.historyAvailable, 'false');
  assert.equal(second.historyCount, 0);
});

test('11. existing CSV renderer smoke succeeds', () => {
  const projected = projectWorkOrderRegister(source());
  const envelope: PublicReportingExport = {
    metadata: {
      dataset: 'WORK_ORDER_REGISTER',
      datasetLabel: 'Work Order Register',
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
  assert.match(csv.text, /Work Order No,.*Status/u);
  assert.match(csv.text, /WO-0001/u);
  assert.match(csv.text, /COMPLETED/u);
  assert.match(csv.text, /APPROVED/u);
  // Two data rows + header = three CRLF-terminated lines + trailing newline.
  assert.ok(csv.text.split('\r\n').length >= 3);
});
