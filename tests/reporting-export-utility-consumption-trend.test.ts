import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { contextAccessService } from '../src/modules/context-access';
import {
  utilityMeterConsumptionRepository,
  utilityMeterConsumptionService,
  type PublicUtilityConsumptionTrendBucket,
  type UtilityConsumptionTrendSourceRow,
} from '../src/modules/utility-meter-consumptions';
import { getReportingExportDatasetAdapter } from '../src/modules/reporting-export/reporting-export.registry';
import { REPORTING_EXPORT_DATASETS } from '../src/modules/reporting-export/reporting-export.types';
import { parseReportingExportQuery } from '../src/modules/reporting-export/reporting-export.validation';

const buildingOne = '11111111-1111-1111-1111-111111111111';
const buildingTwo = '22222222-2222-2222-2222-222222222222';
const inaccessibleBuilding = '33333333-3333-3333-3333-333333333333';
const actorUserId = '44444444-4444-4444-4444-444444444444';
const uomKwh = '55555555-5555-5555-5555-555555555555';
const uomM3 = '66666666-6666-6666-6666-666666666666';

const periodStart = new Date('2026-01-01T00:00:00.000Z');
const periodEnd = new Date('2026-04-01T00:00:00.000Z');

function sourceBucket(
  buildingId: string,
  utilityType: 'ELECTRICITY' | 'WATER' | 'GAS',
  uomId: string,
  value: string,
): UtilityConsumptionTrendSourceRow {
  return {
    buildingId,
    periodStart: new Date('2026-01-01T00:00:00.000Z'),
    periodEnd: new Date('2026-02-01T00:00:00.000Z'),
    utilityType,
    uomId,
    consumptionValue: value,
    consumptionCount: '2',
  };
}

test('UTILITY_CONSUMPTION_TREND is bounded, source-grouped, and UOM-preserving', async () => {
  assert.equal(REPORTING_EXPORT_DATASETS.length, 26);

  const sourceRows: UtilityConsumptionTrendSourceRow[] = [
    sourceBucket(buildingOne, 'ELECTRICITY', uomKwh, '15.5'),
    sourceBucket(buildingOne, 'ELECTRICITY', uomM3, '7'),
    sourceBucket(buildingTwo, 'WATER', uomM3, '9'),
    sourceBucket(buildingTwo, 'GAS', uomKwh, '3'),
  ];
  const accessible = mock.method(
    contextAccessService,
    'getAccessibleBuildingIds',
    async (actor: string) => {
      assert.equal(actor, actorUserId);
      return [buildingOne, buildingTwo];
    },
  );
  const read = mock.method(
    utilityMeterConsumptionRepository,
    'readConsumptionTrend',
    async (
      buildingIds: readonly string[],
      filters: {
        utilityTypes?: readonly string[];
        periodStart: Date;
        periodEnd: Date;
        interval: string;
      },
    ) => {
      assert.deepEqual(
        buildingIds,
        read.mock.callCount() === 0 ? [buildingOne, buildingTwo] : [buildingOne],
      );
      assert.equal(filters.periodStart, periodStart);
      assert.equal(filters.periodEnd, periodEnd);
      if (read.mock.callCount() === 0) {
        assert.deepEqual(filters.utilityTypes, ['ELECTRICITY', 'WATER', 'GAS']);
      } else {
        assert.equal(filters.utilityTypes, undefined);
      }
      assert.ok(['DAY', 'MONTH', 'YEAR'].includes(filters.interval));
      return sourceRows;
    },
  );

  try {
    const sourceBuckets = await utilityMeterConsumptionService.readUtilityConsumptionTrend(
      {
        buildingIds: [buildingOne, buildingTwo, inaccessibleBuilding],
        utilityTypes: ['ELECTRICITY', 'WATER', 'GAS'],
        periodStart,
        periodEnd,
        interval: 'MONTH',
      },
      actorUserId,
    );

    assert.equal(accessible.mock.callCount(), 1);
    assert.equal(read.mock.callCount(), 1);
    assert.equal(sourceBuckets.length, 4);
    assert.deepEqual(
      sourceBuckets.map((row) => [row.buildingId, row.utilityType, row.uomId, row.consumptionValue]),
      [
        [buildingOne, 'ELECTRICITY', uomKwh, 15.5],
        [buildingOne, 'ELECTRICITY', uomM3, 7],
        [buildingTwo, 'WATER', uomM3, 9],
        [buildingTwo, 'GAS', uomKwh, 3],
      ],
    );

    // The same bounded source path accepts only the frozen DAY/MONTH/YEAR interval vocabulary.
    for (const interval of ['DAY', 'MONTH', 'YEAR'] as const) {
      await utilityMeterConsumptionService.readUtilityConsumptionTrend(
        { buildingIds: [buildingOne], periodStart, periodEnd, interval },
        actorUserId,
      );
    }
    assert.equal(read.mock.callCount(), 4);
    assert.deepEqual(
      read.mock.calls.slice(1).map((call) => call.arguments[1].interval),
      ['DAY', 'MONTH', 'YEAR'],
    );
  } finally {
    mock.restoreAll();
  }

  const reportBuckets: PublicUtilityConsumptionTrendBucket[] = sourceRows.map((row) => ({
    buildingId: row.buildingId,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    interval: 'DAY',
    utilityType: row.utilityType,
    uomId: row.uomId,
    consumptionValue: Number(row.consumptionValue),
  }));
  const sourceRead = mock.method(
    utilityMeterConsumptionService,
    'readUtilityConsumptionTrend',
    async (request, actor) => {
      assert.deepEqual(request, {
        buildingIds: [buildingOne, buildingTwo],
        utilityTypes: ['ELECTRICITY', 'WATER', 'GAS'],
        periodStart: new Date('2026-01-01T00:00:00.000Z'),
        periodEnd: new Date('2026-04-01T00:00:00.000Z'),
        interval: 'DAY',
      });
      assert.equal(actor, actorUserId);
      return reportBuckets;
    },
  );
  try {
    const adapter = getReportingExportDatasetAdapter('UTILITY_CONSUMPTION_TREND');
    assert.equal(adapter.dataset, 'UTILITY_CONSUMPTION_TREND');
    assert.equal(adapter.datasetLabel, 'Utility Consumption Trend');

    const parsed = parseReportingExportQuery({
      dataset: 'UTILITY_CONSUMPTION_TREND',
      buildingIds: [buildingOne, buildingTwo],
      utilityTypes: ['ELECTRICITY', 'WATER', 'GAS'],
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
      interval: 'DAY',
    });
    const result = await adapter.load(parsed.passThrough, actorUserId);

    assert.equal(sourceRead.mock.callCount(), 1);
    const [table] = result.projected.tables;
    assert.equal(table!.rowCount, reportBuckets.length);
    assert.deepEqual(table!.columns.map((column) => column.key), [
      'buildingId',
      'periodStart',
      'periodEnd',
      'interval',
      'utilityType',
      'uomId',
      'consumptionValue',
    ]);
    assert.deepEqual(table!.rows.map((row) => row.consumptionValue), [15.5, 7, 9, 3]);
    assert.deepEqual(table!.rows.map((row) => row.uomId), [uomKwh, uomM3, uomM3, uomKwh]);
    assert.deepEqual(table!.rows.map((row) => row.utilityType), [
      'ELECTRICITY',
      'ELECTRICITY',
      'WATER',
      'GAS',
    ]);
    assert.ok(!('previousReadingValue' in table!.rows[0]!));
    assert.ok(!('currentReadingValue' in table!.rows[0]!));
    assert.ok(!('delta' in table!.rows[0]!));
    assert.ok(!('cost' in table!.rows[0]!));
  } finally {
    mock.restoreAll();
  }
});
