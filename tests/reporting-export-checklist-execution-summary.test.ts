import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReportingCsv } from '../src/modules/reporting-export/csv-renderer';
import { getReportingExportDatasetAdapter } from '../src/modules/reporting-export/reporting-export.registry';
import { projectChecklistExecutionSummary } from '../src/modules/reporting-export/reporting-export.projections';
import type { PublicReportingExport } from '../src/modules/reporting-export/reporting-export.types';
import { parseReportingExportQuery } from '../src/modules/reporting-export/reporting-export.validation';
import type {
  PublicChecklistExecutionSummary,
  PublicChecklistExecutionSummaryRow,
} from '../src/modules/checklist-execution-summary';

/**
 * R04 PART 01 RETRY — CHECKLIST_EXECUTION_SUMMARY dataset focused validation.
 *
 * No database: the adapter delegates loading to the backend-owned
 * checklist-execution-summary read contract. Live integration belongs to
 * CI/dev. This file proves the Reporting-owned surface only.
 */

function ceFull(): PublicChecklistExecutionSummaryRow {
  return {
    engine: 'CHECKLIST_EXECUTION',
    executionId: '11111111-1111-1111-1111-111111111111',
    status: 'COMPLETED',
    startedAt: '2026-09-02T00:00:00.000Z',
    completedAt: '2026-09-05T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-05T00:01:00.000Z',
    templateId: '22222222-2222-2222-2222-222222222222',
    templateCode: 'CL-ENG-01',
    templateName: 'Engineering Daily',
    templateVersionId: null,
    templateVersionNumber: null,
    clientId: '33333333-3333-3333-3333-333333333333',
    buildingId: '44444444-4444-4444-4444-444444444444',
    assetId: '55555555-5555-5555-5555-555555555555',
    functionalLocationId: '66666666-6666-6666-6666-666666666666',
    vendorId: null,
    itemCount: 12,
    evidenceCount: 3,
    findingCount: 2,
    verificationReviewId: '77777777-7777-7777-7777-777777777777',
    verificationReviewStatus: 'COMPLETED',
    verificationDecision: 'APPROVED',
    verificationReviewerUserId: '88888888-8888-8888-8888-888888888888',
    verificationReviewedAt: '2026-09-05T01:00:00.000Z',
  };
}

function fiFull(): PublicChecklistExecutionSummaryRow {
  return {
    engine: 'FORM_INSTANCE',
    executionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    status: 'COMPLETED',
    startedAt: '2026-09-03T00:00:00.000Z',
    completedAt: '2026-09-04T00:00:00.000Z',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-04T00:01:00.000Z',
    templateId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    templateCode: 'FT-METER',
    templateName: 'Meter Log Form',
    templateVersionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    templateVersionNumber: 3,
    clientId: '33333333-3333-3333-3333-333333333333',
    buildingId: '44444444-4444-4444-4444-444444444444',
    assetId: '55555555-5555-5555-5555-555555555555',
    functionalLocationId: '66666666-6666-6666-6666-666666666666',
    vendorId: null,
    itemCount: 6,
    evidenceCount: 1,
    findingCount: 0,
    verificationReviewId: null,
    verificationReviewStatus: null,
    verificationDecision: null,
    verificationReviewerUserId: null,
    verificationReviewedAt: null,
  };
}

function source(): PublicChecklistExecutionSummary {
  return {
    buildingId: null,
    buildingScope: ['44444444-4444-4444-4444-444444444444'],
    dateFrom: '2026-09-01',
    dateTo: '2026-09-11',
    asOf: '2026-09-11T00:00:00.000Z',
    rows: [ceFull(), fiFull()],
  };
}

test('1. registry resolves CHECKLIST_EXECUTION_SUMMARY with governed contract', () => {
  const adapter = getReportingExportDatasetAdapter('CHECKLIST_EXECUTION_SUMMARY');
  assert.equal(adapter.dataset, 'CHECKLIST_EXECUTION_SUMMARY');
  assert.equal(adapter.datasetLabel, 'Checklist Execution Summary');
  assert.equal(
    adapter.sourceAuthority,
    'CR-BE-REPORT-READ-04 checklist-execution-summary',
  );
  assert.equal(adapter.requiredReadPermission, 'checklist.read');
  assert.equal(typeof adapter.load, 'function');
});

test('3. query filters pass through module-owned parser untouched', () => {
  const filters = parseReportingExportQuery({
    dataset: 'CHECKLIST_EXECUTION_SUMMARY',
    buildingId: '44444444-4444-4444-4444-444444444444',
    engine: 'CHECKLIST_EXECUTION',
    status: 'COMPLETED',
    templateId: '22222222-2222-2222-2222-222222222222',
    assetId: '55555555-5555-5555-5555-555555555555',
    functionalLocationId: '66666666-6666-6666-6666-666666666666',
    vendorId: null,
    verificationDecision: 'APPROVED',
    dateFrom: '2026-09-01',
    dateTo: '2026-09-11',
  });
  assert.equal(filters.dataset, 'CHECKLIST_EXECUTION_SUMMARY');
  assert.equal(filters.buildingId, '44444444-4444-4444-4444-444444444444');
  assert.equal(filters.dateFrom, '2026-09-01');
  assert.equal(filters.dateTo, '2026-09-11');
  assert.equal(filters.passThrough.engine, 'CHECKLIST_EXECUTION');
  assert.equal(filters.passThrough.status, 'COMPLETED');
  assert.equal(filters.passThrough.templateId, '22222222-2222-2222-2222-222222222222');
  assert.equal(filters.passThrough.assetId, '55555555-5555-5555-5555-555555555555');
  assert.equal(
    filters.passThrough.functionalLocationId,
    '66666666-6666-6666-6666-666666666666',
  );
  assert.equal(filters.passThrough.verificationDecision, 'APPROVED');
});

test('5/6/7/8/9/10/11/12/13. projection preserves both engines verbatim, counts, verification, null-safety, kpis empty, forbidden fields absent', () => {
  const projected = projectChecklistExecutionSummary(source());
  assert.deepEqual(projected.kpis, []);
  assert.equal(projected.tables.length, 1);

  const [t] = projected.tables;
  assert.equal(t.key, 'checklistExecutionSummary');
  assert.equal(t.label, 'Checklist Execution Summary');
  assert.equal(t.rowCount, 2);

  const columnKeys = t.columns.map(c => c.key);
  for (const k of Object.keys(ceFull())) {
    assert.ok(columnKeys.includes(k), `column ${k} must be projected`);
  }
  for (const forbidden of [
    'executionNumber', 'submittedAt', 'domain', 'reportFamily',
    'executedByUserId', 'workforceProfileId', 'teamId', 'executorVendorId', 'assignedAt',
    'answeredCount', 'passCount', 'failCount', 'abnormalCount',
    'exceptionCount', 'compliantCount', 'nonCompliantCount',
    'openFindingCount', 'reworkCount', 'reworkStatus',
    'historyCount', 'historyAvailable',
    'floorId', 'areaId', 'roomId', 'spaceId', 'tenantId',
  ]) {
    assert.ok(!columnKeys.includes(forbidden), `${forbidden} must NOT be projected`);
  }

  const ce = t.rows.find(r => r.executionId === ceFull().executionId)!;
  assert.equal(ce.engine, 'CHECKLIST_EXECUTION');
  assert.equal(ce.status, 'COMPLETED');
  assert.equal(ce.templateId, '22222222-2222-2222-2222-222222222222');
  assert.equal(ce.templateCode, 'CL-ENG-01');
  assert.equal(ce.templateName, 'Engineering Daily');
  assert.equal(ce.templateVersionId, null);
  assert.equal(ce.templateVersionNumber, null);
  assert.equal(ce.buildingId, '44444444-4444-4444-4444-444444444444');
  assert.equal(ce.assetId, '55555555-5555-5555-5555-555555555555');
  assert.equal(ce.functionalLocationId, '66666666-6666-6666-6666-666666666666');
  assert.equal(ce.vendorId, null);
  assert.equal(ce.itemCount, 12);
  assert.equal(ce.evidenceCount, 3);
  assert.equal(ce.findingCount, 2);
  assert.equal(ce.verificationReviewStatus, 'COMPLETED');
  assert.equal(ce.verificationDecision, 'APPROVED');

  const fi = t.rows.find(r => r.executionId === fiFull().executionId)!;
  assert.equal(fi.engine, 'FORM_INSTANCE');
  assert.equal(fi.templateId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert.equal(fi.templateCode, 'FT-METER');
  assert.equal(fi.templateVersionId, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
  assert.equal(fi.templateVersionNumber, 3);
  assert.equal(fi.verificationReviewId, null);
  assert.equal(fi.verificationDecision, null);
});

test('14. existing CSV renderer smoke succeeds', () => {
  const projected = projectChecklistExecutionSummary(source());
  const envelope: PublicReportingExport = {
    metadata: {
      dataset: 'CHECKLIST_EXECUTION_SUMMARY',
      datasetLabel: 'Checklist Execution Summary',
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
  assert.match(csv.text, /Execution Id,.*Status/u);
  assert.match(csv.text, /CHECKLIST_EXECUTION/u);
  assert.match(csv.text, /FORM_INSTANCE/u);
  assert.match(csv.text, /APPROVED/u);
});
