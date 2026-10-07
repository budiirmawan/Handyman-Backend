import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { esgMetricValueService } from '../src/modules/esg-metric-values';
import { esgWasteRecordService } from '../src/modules/esg-waste-records';
import { incidentService } from '../src/modules/incidents';
import { checklistExecutionSummaryService } from '../src/modules/checklist-execution-summary';
import { findingRegisterService } from '../src/modules/finding-register';
import { scheduledOperationLineageService } from '../src/modules/scheduled-operation-lineage';
import { utilityMeterConsumptionService } from '../src/modules/utility-meter-consumptions';
import { UTILITY_TYPES } from '../src/modules/utility-meters/utility-meter.types';
import { UTILITY_AGGREGATION_INTERVALS } from '../src/modules/utility-aggregations/utility-aggregation.types';
import { workOrderRegisterService } from '../src/modules/work-order-register';
import { getReportingExportDatasetAdapter } from '../src/modules/reporting-export/reporting-export.registry';
import {
  PORTFOLIO_OPERATIONAL_COMPARISON_METRICS,
  REPORTING_EXPORT_DATASETS,
} from '../src/modules/reporting-export/reporting-export.types';

const r12Datasets = [
  'ESG_METRIC_TREND',
  'ESG_WASTE_REGISTER',
  'UTILITY_CONSUMPTION_TREND',
  'PORTFOLIO_OPERATIONAL_COMPARISON',
] as const;
const buildingOne = '11111111-1111-4111-8111-111111111111';
const buildingTwo = '22222222-2222-4222-8222-222222222222';
const actorUserId = '33333333-3333-4333-8333-333333333333';
const periodStart = '2026-06-01';
const periodEnd = '2026-06-30';

function assertNoReportingOwnedFacts(row: Record<string, unknown>): void {
  for (const key of [
    'carbon',
    'co2e',
    'emissionFactor',
    'normalizedValue',
    'grossFloorArea',
    'occupiedArea',
    'occupantCount',
    'tenantCount',
    'score',
    'rank',
    'percentile',
    'benchmark',
    'cost',
    'delta',
    'breachedAt',
    'completedAt',
  ]) {
    assert.ok(!(key in row), `Reporting must not own ${key}.`);
  }
}

test('R12 current-head closure guard', async () => {
  assert.equal(REPORTING_EXPORT_DATASETS.length, 27);
  assert.deepEqual(
    REPORTING_EXPORT_DATASETS.filter((dataset) =>
      (r12Datasets as readonly string[]).includes(dataset),
    ),
    r12Datasets,
  );
  assert.deepEqual(PORTFOLIO_OPERATIONAL_COMPARISON_METRICS, [
    'WORK_ORDER_ORIGINATED',
    'FINDING_REPORTED',
    'INCIDENT_REPORTED',
    'CHECKLIST_EXECUTION_ORIGINATED',
    'SCHEDULED_OPERATION_PLANNED',
  ]);
  assert.deepEqual(UTILITY_AGGREGATION_INTERVALS, ['DAY', 'MONTH', 'YEAR']);
  assert.deepEqual(UTILITY_TYPES, ['ELECTRICITY', 'WATER', 'GAS']);

  const metricRead = mock.method(
    esgMetricValueService,
    'readEsgMetricValues',
    async (request, actor) => {
      assert.deepEqual(request, {
        buildingIds: [buildingOne, buildingTwo],
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-12-31T00:00:00.000Z',
      });
      assert.equal(actor, actorUserId);
      return [
        {
          id: '44444444-4444-4444-4444-444444444444',
          buildingId: buildingOne,
          metricDefinitionId: '55555555-5555-5555-5555-555555555555',
          periodType: 'MONTHLY',
          periodStart: '2026-06-01T00:00:00.000Z',
          periodEnd: '2026-07-01T00:00:00.000Z',
          value: 12.5,
          uomId: '66666666-6666-6666-6666-666666666666',
          dataQuality: 'ACTUAL',
          verificationStatus: 'VERIFIED',
          sourceType: 'IMPORT',
          calculationMethod: 'MANUAL',
        },
      ];
    },
  );
  const metricResult = await getReportingExportDatasetAdapter('ESG_METRIC_TREND').load(
    {
      buildingIds: [buildingOne, buildingTwo],
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-12-31T00:00:00.000Z',
    },
    actorUserId,
  );
  assert.equal(metricRead.mock.callCount(), 1);
  assert.equal(metricResult.projected.tables[0]!.rowCount, 1);
  assertNoReportingOwnedFacts(metricResult.projected.tables[0]!.rows[0]!);
  mock.restoreAll();

  const wasteRead = mock.method(
    esgWasteRecordService,
    'readEsgWasteRecords',
    async (request, actor) => {
      assert.deepEqual(request, {
        buildingIds: [buildingOne, buildingTwo],
        periodStart,
        periodEnd,
      });
      assert.equal(actor, actorUserId);
      return [
        {
          id: '77777777-7777-4777-8777-777777777777',
          buildingId: buildingOne,
          periodDate: '2026-06-15',
          wasteType: 'GENERAL',
          disposalMethod: 'RECYCLED',
          quantity: 3.5,
          uomId: '88888888-8888-4888-8888-888888888888',
          status: 'ACTIVE',
        },
      ];
    },
  );
  const wasteResult = await getReportingExportDatasetAdapter('ESG_WASTE_REGISTER').load(
    { buildingIds: [buildingOne, buildingTwo], periodStart, periodEnd },
    actorUserId,
  );
  assert.equal(wasteRead.mock.callCount(), 1);
  assert.equal(wasteResult.projected.tables[0]!.rowCount, 1);
  assert.equal(wasteResult.projected.tables[0]!.rows[0]!.quantity, 3.5);
  assertNoReportingOwnedFacts(wasteResult.projected.tables[0]!.rows[0]!);
  mock.restoreAll();

  const utilityRead = mock.method(
    utilityMeterConsumptionService,
    'readUtilityConsumptionTrend',
    async (request, actor) => {
      assert.deepEqual(request, {
        buildingIds: [buildingOne, buildingTwo],
        utilityTypes: ['ELECTRICITY', 'WATER', 'GAS'],
        periodStart: new Date('2026-01-01T00:00:00.000Z'),
        periodEnd: new Date('2026-04-01T00:00:00.000Z'),
        interval: 'MONTH',
      });
      assert.equal(actor, actorUserId);
      return [
        {
          buildingId: buildingOne,
          periodStart: '2026-01-01T00:00:00.000Z',
          periodEnd: '2026-02-01T00:00:00.000Z',
          interval: 'MONTH',
          utilityType: 'ELECTRICITY',
          uomId: '99999999-9999-4999-8999-999999999999',
          consumptionValue: 15.5,
        },
        {
          buildingId: buildingOne,
          periodStart: '2026-01-01T00:00:00.000Z',
          periodEnd: '2026-02-01T00:00:00.000Z',
          interval: 'MONTH',
          utilityType: 'ELECTRICITY',
          uomId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          consumptionValue: 7,
        },
      ];
    },
  );
  const utilityResult = await getReportingExportDatasetAdapter('UTILITY_CONSUMPTION_TREND').load(
    {
      buildingIds: [buildingOne, buildingTwo],
      utilityTypes: ['ELECTRICITY', 'WATER', 'GAS'],
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
      interval: 'MONTH',
    },
    actorUserId,
  );
  assert.equal(utilityRead.mock.callCount(), 1);
  assert.equal(utilityResult.projected.tables[0]!.rowCount, 2);
  assert.deepEqual(
    utilityResult.projected.tables[0]!.rows.map((row) => [row.uomId, row.consumptionValue]),
    [
      ['99999999-9999-4999-8999-999999999999', 15.5],
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 7],
    ],
  );
  for (const row of utilityResult.projected.tables[0]!.rows) {
    assertNoReportingOwnedFacts(row);
    assert.ok(!('previousReadingValue' in row));
    assert.ok(!('currentReadingValue' in row));
  }
  mock.restoreAll();

  const sourceFilters = { dateFrom: periodStart, dateTo: periodEnd };
  const workOrders = mock.method(workOrderRegisterService, 'getWorkOrderRegister', async (filters, actor) => {
    assert.deepEqual(filters, sourceFilters);
    assert.equal(actor, actorUserId);
    assert.ok(!('buildingId' in filters));
    return { rows: [{ buildingId: buildingOne }] };
  });
  const findings = mock.method(findingRegisterService, 'getFindingRegister', async (filters, actor) => {
    assert.deepEqual(filters, sourceFilters);
    assert.equal(actor, actorUserId);
    assert.ok(!('buildingId' in filters));
    return { rows: [{ buildingId: buildingOne }] };
  });
  const incidents = mock.method(incidentService, 'listIncidents', async (filters, actor) => {
    assert.deepEqual(filters, {});
    assert.equal(actor, actorUserId);
    return [
      { buildingId: buildingOne, reportedAt: '2026-06-15T00:00:00.000Z' },
      { buildingId: buildingOne, reportedAt: '2026-07-01T00:00:00.000Z' },
    ];
  });
  const executions = mock.method(checklistExecutionSummaryService, 'getChecklistExecutionSummary', async (filters, actor) => {
    assert.deepEqual(filters, sourceFilters);
    assert.equal(actor, actorUserId);
    assert.ok(!('buildingId' in filters));
    return { rows: [{ buildingId: buildingOne }] };
  });
  const scheduled = mock.method(scheduledOperationLineageService, 'getScheduledOperationLineage', async (filters, actor) => {
    assert.deepEqual(filters, sourceFilters);
    assert.equal(actor, actorUserId);
    assert.ok(!('buildingId' in filters));
    return { rows: [{ buildingId: buildingOne }] };
  });

  try {
    const portfolioResult = await getReportingExportDatasetAdapter('PORTFOLIO_OPERATIONAL_COMPARISON').load(
      { buildingIds: [buildingOne, buildingTwo], periodStart, periodEnd },
      actorUserId,
    );
    assert.deepEqual(
      [workOrders, findings, incidents, executions, scheduled].map((read) => read.mock.callCount()),
      [1, 1, 1, 1, 1],
    );
    const portfolioRows = portfolioResult.projected.tables[0]!.rows;
    assert.deepEqual(
      portfolioRows.map((row) => row.metric),
      [
        'WORK_ORDER_ORIGINATED',
        'FINDING_REPORTED',
        'INCIDENT_REPORTED',
        'CHECKLIST_EXECUTION_ORIGINATED',
        'SCHEDULED_OPERATION_PLANNED',
      ],
    );
    assert.ok(portfolioRows.every((row) => row.buildingId === buildingOne));
    assert.ok(!portfolioRows.some((row) => row.buildingId === buildingTwo || row.value === 0));
    for (const row of portfolioRows) {
      assertNoReportingOwnedFacts(row);
    }
  } finally {
    mock.restoreAll();
  }
});
