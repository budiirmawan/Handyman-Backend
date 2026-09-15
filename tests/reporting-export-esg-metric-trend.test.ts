import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { esgMetricValueService } from '../src/modules/esg-metric-values';
import { getReportingExportDatasetAdapter } from '../src/modules/reporting-export/reporting-export.registry';
import { projectEsgMetricTrend } from '../src/modules/reporting-export/reporting-export.r12-projections';
import { REPORTING_EXPORT_DATASETS } from '../src/modules/reporting-export/reporting-export.types';
import { parseReportingExportQuery } from '../src/modules/reporting-export/reporting-export.validation';
import type { PublicEsgMetricValue } from '../src/modules/esg-metric-values';

const buildingId = '11111111-1111-1111-1111-111111111111';
const metricDefinitionId = '22222222-2222-2222-2222-222222222222';
const metricValueId = '33333333-3333-3333-3333-333333333333';
const actorUserId = '44444444-4444-4444-4444-444444444444';

function sourceRow(): PublicEsgMetricValue {
  return {
    id: metricValueId,
    clientId: '55555555-5555-5555-5555-555555555555',
    buildingId,
    metricDefinitionId,
    periodType: 'MONTHLY',
    periodStart: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-02-01T00:00:00.000Z',
    value: 12.5,
    uomId: '66666666-6666-6666-6666-666666666666',
    calculationMethod: 'MANUAL',
    sourceType: 'IMPORT',
    sourceRefs: ['import-row-7'],
    dataQuality: 'ACTUAL',
    verificationStatus: 'VERIFIED',
    createdByUserId: '77777777-7777-7777-7777-777777777777',
    createdAt: '2026-02-01T01:00:00.000Z',
    updatedAt: '2026-02-01T01:00:00.000Z',
  };
}

test('ESG_METRIC_TREND delegates the bounded source read and projects one fact without calculation', async () => {
  assert.equal(REPORTING_EXPORT_DATASETS.length, 24);

  const adapter = getReportingExportDatasetAdapter('ESG_METRIC_TREND');
  assert.equal(adapter.dataset, 'ESG_METRIC_TREND');
  assert.equal(adapter.datasetLabel, 'ESG Metric Trend');
  assert.equal(adapter.requiredReadPermission, 'esg.read');

  const parsed = parseReportingExportQuery({
    dataset: 'ESG_METRIC_TREND',
    buildingIds: [buildingId],
    metricDefinitionIds: [metricDefinitionId],
    periodStart: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-12-31T00:00:00.000Z',
  });
  assert.deepEqual(parsed.passThrough, {
    buildingIds: [buildingId],
    metricDefinitionIds: [metricDefinitionId],
    periodStart: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-12-31T00:00:00.000Z',
  });

  const source = sourceRow();
  const read = mock.method(esgMetricValueService, 'readEsgMetricValues', async () => [source]);
  try {
    const result = await adapter.load(parsed.passThrough, actorUserId);
    assert.deepEqual(read.mock.calls[0]?.arguments, [
      {
        buildingIds: [buildingId],
        metricDefinitionIds: [metricDefinitionId],
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-12-31T00:00:00.000Z',
      },
      actorUserId,
    ]);

    assert.deepEqual(result.projected.kpis, []);
    assert.equal(result.projected.tables.length, 1);
    const [table] = result.projected.tables;
    assert.equal(table!.rowCount, 1);
    assert.deepEqual(table!.columns.map((column) => column.key), [
      'metricValueId',
      'buildingId',
      'metricDefinitionId',
      'periodType',
      'periodStart',
      'periodEnd',
      'value',
      'uomId',
      'dataQuality',
      'verificationStatus',
      'sourceType',
      'calculationMethod',
    ]);
    assert.deepEqual(table!.rows[0], {
      metricValueId,
      buildingId,
      metricDefinitionId,
      periodType: 'MONTHLY',
      periodStart: source.periodStart,
      periodEnd: source.periodEnd,
      value: source.value,
      uomId: source.uomId,
      dataQuality: source.dataQuality,
      verificationStatus: source.verificationStatus,
      sourceType: source.sourceType,
      calculationMethod: source.calculationMethod,
    });
    assert.ok(!('sourceRefs' in table!.rows[0]!));
    assert.equal(result.common.dateFrom, '2026-01-01T00:00:00.000Z');
    assert.equal(result.common.dateTo, '2026-12-31T00:00:00.000Z');
  } finally {
    mock.restoreAll();
  }

  const directProjection = projectEsgMetricTrend([source]);
  assert.equal(directProjection.tables[0]!.rows.length, 1);
  assert.equal(directProjection.tables[0]!.rows[0]!.value, 12.5);
});
