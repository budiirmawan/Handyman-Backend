import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { incidentService } from '../src/modules/incidents';
import { checklistExecutionSummaryService } from '../src/modules/checklist-execution-summary';
import { findingRegisterService } from '../src/modules/finding-register';
import { scheduledOperationLineageService } from '../src/modules/scheduled-operation-lineage';
import { workOrderRegisterService } from '../src/modules/work-order-register';
import { getReportingExportDatasetAdapter } from '../src/modules/reporting-export/reporting-export.registry';
import { REPORTING_EXPORT_DATASETS } from '../src/modules/reporting-export/reporting-export.types';
import { parseReportingExportQuery } from '../src/modules/reporting-export/reporting-export.validation';

const buildingOne = '11111111-1111-4111-8111-111111111111';
const buildingTwo = '22222222-2222-4222-8222-222222222222';
const actorUserId = '33333333-3333-4333-8333-333333333333';
const periodStart = '2026-06-01';
const periodEnd = '2026-06-30';

const rows = (buildingId: string, count: number) =>
  Array.from({ length: count }, () => ({ buildingId }));

function assertSetBasedSourceFilters(filters: Record<string, unknown>, actor: string): void {
  assert.equal(actor, actorUserId);
  assert.deepEqual(filters, { dateFrom: periodStart, dateTo: periodEnd });
  assert.ok(!('buildingId' in filters), 'sources must use their existing accessible-set read');
  assert.ok(!('clientId' in filters), 'no caller Client scope may be forwarded');
}

test('PORTFOLIO_OPERATIONAL_COMPARISON counts governed rows without synthetic comparison facts', async () => {
  assert.equal(REPORTING_EXPORT_DATASETS.length, 27);

  const workOrders = mock.method(
    workOrderRegisterService,
    'getWorkOrderRegister',
    async (filters, actor) => {
      assertSetBasedSourceFilters(filters, actor);
      return { rows: [...rows(buildingOne, 2), ...rows(buildingTwo, 0)] };
    },
  );
  const findings = mock.method(
    findingRegisterService,
    'getFindingRegister',
    async (filters, actor) => {
      assertSetBasedSourceFilters(filters, actor);
      return { rows: [...rows(buildingOne, 1), ...rows(buildingTwo, 2)] };
    },
  );
  const incidents = mock.method(
    incidentService,
    'listIncidents',
    async (filters, actor) => {
      assert.deepEqual(filters, {});
      assert.equal(actor, actorUserId);
      return [
        { buildingId: buildingOne, reportedAt: '2026-06-10T00:00:00.000Z' },
        { buildingId: buildingOne, reportedAt: '2026-06-30T23:59:59.000Z' },
        { buildingId: buildingTwo, reportedAt: '2026-07-01T00:00:00.000Z' },
      ];
    },
  );
  const executions = mock.method(
    checklistExecutionSummaryService,
    'getChecklistExecutionSummary',
    async (filters, actor) => {
      assertSetBasedSourceFilters(filters, actor);
      return { rows: [...rows(buildingOne, 1), ...rows(buildingTwo, 1)] };
    },
  );
  const scheduled = mock.method(
    scheduledOperationLineageService,
    'getScheduledOperationLineage',
    async (filters, actor) => {
      assertSetBasedSourceFilters(filters, actor);
      return { rows: [...rows(buildingOne, 1), ...rows(buildingTwo, 0)] };
    },
  );

  try {
    const adapter = getReportingExportDatasetAdapter('PORTFOLIO_OPERATIONAL_COMPARISON');
    assert.equal(adapter.dataset, 'PORTFOLIO_OPERATIONAL_COMPARISON');
    assert.equal(adapter.datasetLabel, 'Portfolio Operational Comparison');

    const parsed = parseReportingExportQuery({
      dataset: 'PORTFOLIO_OPERATIONAL_COMPARISON',
      buildingIds: [buildingOne, buildingTwo],
      periodStart,
      periodEnd,
    });
    const result = await adapter.load(parsed.passThrough, actorUserId);

    assert.equal(workOrders.mock.callCount(), 1);
    assert.equal(findings.mock.callCount(), 1);
    assert.equal(incidents.mock.callCount(), 1);
    assert.equal(executions.mock.callCount(), 1);
    assert.equal(scheduled.mock.callCount(), 1);

    const [table] = result.projected.tables;
    assert.deepEqual(table!.columns.map((column) => column.key), [
      'buildingId',
      'metric',
      'value',
      'periodStart',
      'periodEnd',
    ]);
    assert.deepEqual(table!.rows, [
      { buildingId: buildingOne, metric: 'WORK_ORDER_ORIGINATED', value: 2, periodStart, periodEnd },
      { buildingId: buildingOne, metric: 'FINDING_REPORTED', value: 1, periodStart, periodEnd },
      { buildingId: buildingOne, metric: 'INCIDENT_REPORTED', value: 2, periodStart, periodEnd },
      { buildingId: buildingOne, metric: 'CHECKLIST_EXECUTION_ORIGINATED', value: 1, periodStart, periodEnd },
      { buildingId: buildingOne, metric: 'SCHEDULED_OPERATION_PLANNED', value: 1, periodStart, periodEnd },
      { buildingId: buildingTwo, metric: 'FINDING_REPORTED', value: 2, periodStart, periodEnd },
      { buildingId: buildingTwo, metric: 'CHECKLIST_EXECUTION_ORIGINATED', value: 1, periodStart, periodEnd },
    ]);
    assert.equal(table!.rowCount, 7);
    assert.deepEqual(result.projected.kpis, []);
    assert.ok(!('score' in table!.rows[0]!));
    assert.ok(!('rank' in table!.rows[0]!));
    assert.ok(!('denominator' in table!.rows[0]!));
    assert.ok(!('normalizedValue' in table!.rows[0]!));
    assert.ok(!table!.rows.some((row) => row.value === 0));
  } finally {
    mock.restoreAll();
  }
});
