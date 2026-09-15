import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contextAccessService } from '../src/modules/context-access';
import {
  esgMetricValueRepository,
  type EsgMetricValueRecord,
} from '../src/modules/esg-metric-values';
import { readEsgMetricValues } from '../src/modules/esg-metric-values';

const BUILDING_A = '11111111-1111-4111-8111-111111111111';
const BUILDING_B = '22222222-2222-4222-8222-222222222222';
const BUILDING_INACCESSIBLE = '33333333-3333-4333-8333-333333333333';
const METRIC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const METRIC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UOM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACTOR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SOURCE_REF = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const PERIOD_START = '2026-01-01T00:00:00.000Z';
const PERIOD_END = '2026-04-01T00:00:00.000Z';

function record(buildingId: string, metricDefinitionId: string, value: string): EsgMetricValueRecord {
  return {
    id: `${buildingId.slice(0, 8)}-0000-4000-8000-000000000000`,
    clientId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    buildingId,
    metricDefinitionId,
    periodType: 'QUARTERLY',
    periodStart: new Date(PERIOD_START),
    periodEnd: new Date(PERIOD_END),
    value,
    uomId: UOM,
    calculationMethod: 'MANUAL',
    sourceType: 'IMPORT',
    sourceRefs: [SOURCE_REF],
    dataQuality: 'ESTIMATED',
    verificationStatus: 'VERIFIED',
    createdByUserId: ACTOR,
    createdAt: new Date('2026-04-01T00:00:01.000Z'),
    updatedAt: new Date('2026-04-01T00:00:02.000Z'),
  };
}

describe('ESG metric-value bounded read foundation', () => {
  it('reads an authorized multi-Building set without allowing an inaccessible Building to widen scope', async () => {
    const originalScope = contextAccessService.getAccessibleBuildingIds;
    const originalRead = esgMetricValueRepository.listBounded;
    let captured: {
      buildingIds: readonly string[];
      metricDefinitionIds: readonly string[] | undefined;
      periodStart: Date;
      periodEnd: Date;
    } | undefined;

    contextAccessService.getAccessibleBuildingIds = async (userId: string) => {
      assert.equal(userId, ACTOR);
      return [BUILDING_A, BUILDING_B];
    };
    esgMetricValueRepository.listBounded = async (
      _executor,
      buildingIds,
      metricDefinitionIds,
      periodStart,
      periodEnd,
    ) => {
      captured = { buildingIds, metricDefinitionIds, periodStart, periodEnd };
      return [record(BUILDING_A, METRIC_A, '12.5'), record(BUILDING_B, METRIC_B, '27.5')];
    };

    try {
      const rows = await readEsgMetricValues(
        {
          buildingIds: [BUILDING_A, BUILDING_INACCESSIBLE, BUILDING_B],
          metricDefinitionIds: [METRIC_A, METRIC_B],
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
        },
        ACTOR,
      );

      assert.deepEqual(captured?.buildingIds, [BUILDING_A, BUILDING_B]);
      assert.deepEqual(captured?.metricDefinitionIds, [METRIC_A, METRIC_B]);
      assert.equal(captured?.periodStart.toISOString(), PERIOD_START);
      assert.equal(captured?.periodEnd.toISOString(), PERIOD_END);
      assert.deepEqual(rows.map((row) => row.buildingId), [BUILDING_A, BUILDING_B]);
      assert.deepEqual(rows.map((row) => row.value), [12.5, 27.5]);
      assert.equal(rows[0].uomId, UOM);
      assert.equal(rows[0].verificationStatus, 'VERIFIED');
      assert.equal(rows[0].calculationMethod, 'MANUAL');
      assert.equal(rows[0].sourceType, 'IMPORT');
      assert.deepEqual(rows[0].sourceRefs, [SOURCE_REF]);
    } finally {
      contextAccessService.getAccessibleBuildingIds = originalScope;
      esgMetricValueRepository.listBounded = originalRead;
    }
  });

  it('fails closed when the effective Building scope is empty', async () => {
    const originalScope = contextAccessService.getAccessibleBuildingIds;
    const originalRead = esgMetricValueRepository.listBounded;
    let repositoryCalled = false;

    contextAccessService.getAccessibleBuildingIds = async () => [];
    esgMetricValueRepository.listBounded = async () => {
      repositoryCalled = true;
      return [record(BUILDING_A, METRIC_A, '99')];
    };

    try {
      const rows = await readEsgMetricValues(
        {
          buildingIds: [BUILDING_A],
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
        },
        ACTOR,
      );
      assert.deepEqual(rows, []);
      assert.equal(repositoryCalled, false);
    } finally {
      contextAccessService.getAccessibleBuildingIds = originalScope;
      esgMetricValueRepository.listBounded = originalRead;
    }
  });

  it('uses inclusive containment boundaries in one set-based query and returns rows without aggregation', async () => {
    let sql = '';
    let values: unknown[] = [];
    const rawRows = [
      {
        id: '11111111-0000-4000-8000-000000000001',
        clientId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        buildingId: BUILDING_A,
        metricDefinitionId: METRIC_A,
        periodType: 'QUARTERLY',
        periodStart: new Date(PERIOD_START),
        periodEnd: new Date(PERIOD_END),
        value: '10.25',
        uomId: UOM,
        calculationMethod: 'CALCULATED',
        sourceType: 'SYSTEM',
        sourceRefs: [SOURCE_REF],
        dataQuality: 'ACTUAL',
        verificationStatus: 'PENDING',
        createdByUserId: ACTOR,
        createdAt: new Date(PERIOD_END),
        updatedAt: new Date(PERIOD_END),
      },
      {
        id: '22222222-0000-4000-8000-000000000002',
        clientId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        buildingId: BUILDING_B,
        metricDefinitionId: METRIC_B,
        periodType: 'QUARTERLY',
        periodStart: new Date('2026-02-01T00:00:00.000Z'),
        periodEnd: new Date('2026-03-01T00:00:00.000Z'),
        value: '20.75',
        uomId: UOM,
        calculationMethod: 'HYBRID',
        sourceType: 'MANUAL_ENTRY',
        sourceRefs: null,
        dataQuality: 'ESTIMATED',
        verificationStatus: 'REJECTED',
        createdByUserId: ACTOR,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      },
    ];
    const executor = {
      query: async (statement: string, parameters: unknown[]) => {
        sql = statement;
        values = parameters;
        return { rows: rawRows };
      },
    };

    const rows = await esgMetricValueRepository.listBounded(
      executor,
      [BUILDING_A, BUILDING_B],
      [METRIC_A, METRIC_B],
      new Date(PERIOD_START),
      new Date(PERIOD_END),
    );

    assert.match(sql, /building_id = ANY\(\$1::uuid\[\]\)/);
    assert.match(sql, /period_start >= \$2/);
    assert.match(sql, /period_end <= \$3/);
    assert.match(sql, /metric_definition_id = ANY\(\$4::uuid\[\]\)/);
    assert.deepEqual(values[0], [BUILDING_A, BUILDING_B]);
    assert.deepEqual(values[3], [METRIC_A, METRIC_B]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].value, '10.25');
    assert.equal(rows[1].value, '20.75');
    assert.equal(rows[0].uomId, UOM);
    assert.equal(rows[1].verificationStatus, 'REJECTED');
  });
});
