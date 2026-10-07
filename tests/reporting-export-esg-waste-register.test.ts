import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { contextAccessService } from '../src/modules/context-access';
import { esgWasteRecordRepository } from '../src/modules/esg-waste-records';
import {
  esgWasteRecordService,
  type PublicEsgWasteRecord,
} from '../src/modules/esg-waste-records';
import { getReportingExportDatasetAdapter } from '../src/modules/reporting-export/reporting-export.registry';
import { REPORTING_EXPORT_DATASETS } from '../src/modules/reporting-export/reporting-export.types';
import { parseReportingExportQuery } from '../src/modules/reporting-export/reporting-export.validation';

const accessibleBuildingId = '11111111-1111-1111-1111-111111111111';
const requestedButInaccessibleBuildingId = '22222222-2222-2222-2222-222222222222';
const actorUserId = '33333333-3333-3333-3333-333333333333';
const uomId = '44444444-4444-4444-4444-444444444444';

function wasteRow(
  id: string,
  quantity: number,
  wasteType: PublicEsgWasteRecord['wasteType'],
): PublicEsgWasteRecord {
  return {
    id,
    clientId: '55555555-5555-5555-5555-555555555555',
    buildingId: accessibleBuildingId,
    functionalLocationId: null,
    wasteType,
    disposalMethod: 'RECYCLED',
    quantity,
    uomId,
    periodDate: '2026-08-15',
    sourceType: 'MANUAL',
    vendorId: null,
    notes: null,
    status: 'ACTIVE',
    createdByUserId: actorUserId,
    createdAt: '2026-08-15T01:00:00.000Z',
    updatedAt: '2026-08-15T01:00:00.000Z',
  };
}

test('ESG_WASTE_REGISTER keeps actor scope and persisted waste facts at source grain', async () => {
  assert.equal(REPORTING_EXPORT_DATASETS.length, 25);

  const first = wasteRow('66666666-6666-6666-6666-666666666666', 10.5, 'GENERAL');
  const second = wasteRow('77777777-7777-7777-7777-777777777777', 2.25, 'GENERAL');
  const readRequest = {
    buildingIds: [accessibleBuildingId, requestedButInaccessibleBuildingId],
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
  } as const;

  const accessible = mock.method(
    contextAccessService,
    'getAccessibleBuildingIds',
    async (actor: string) => {
      assert.equal(actor, actorUserId);
      return [accessibleBuildingId];
    },
  );
  const list = mock.method(
    esgWasteRecordRepository,
    'listScoped',
    async (
      executor: unknown,
      buildingIds: string[],
      filters: { dateFrom?: string; dateTo?: string },
    ) => {
      assert.equal(executor, undefined);
      assert.deepEqual(buildingIds, [accessibleBuildingId]);
      assert.deepEqual(filters, { dateFrom: '2026-08-01', dateTo: '2026-08-31' });
      return [
        {
          id: first.id,
          clientId: first.clientId,
          buildingId: first.buildingId,
          functionalLocationId: first.functionalLocationId,
          wasteType: first.wasteType,
          disposalMethod: first.disposalMethod,
          quantity: String(first.quantity),
          uomId: first.uomId,
          periodDate: new Date(`${first.periodDate}T00:00:00.000Z`),
          sourceType: first.sourceType,
          vendorId: first.vendorId,
          notes: first.notes,
          status: first.status,
          createdByUserId: first.createdByUserId,
          createdAt: new Date(first.createdAt),
          updatedAt: new Date(first.updatedAt),
        },
      ];
    },
  );
  try {
    const sourceRows = await esgWasteRecordService.readEsgWasteRecords(
      readRequest,
      actorUserId,
    );
    assert.equal(accessible.mock.callCount(), 1);
    assert.equal(list.mock.callCount(), 1);
    assert.deepEqual(sourceRows.map((row) => row.id), [first.id]);
  } finally {
    mock.restoreAll();
  }

  const sourceRead = mock.method(
    esgWasteRecordService,
    'readEsgWasteRecords',
    async (request, actor) => {
      assert.deepEqual(request, readRequest);
      assert.equal(actor, actorUserId);
      return [first, second];
    },
  );
  try {
    const adapter = getReportingExportDatasetAdapter('ESG_WASTE_REGISTER');
    assert.equal(adapter.dataset, 'ESG_WASTE_REGISTER');
    assert.equal(adapter.datasetLabel, 'ESG Waste Register');
    assert.equal(adapter.sourceAuthority, 'CR-BE-ESG-01 esg-waste-records readEsgWasteRecords');

    const parsed = parseReportingExportQuery({
      dataset: 'ESG_WASTE_REGISTER',
      buildingIds: readRequest.buildingIds,
      periodStart: readRequest.periodStart,
      periodEnd: readRequest.periodEnd,
    });
    const result = await adapter.load(parsed.passThrough, actorUserId);

    assert.equal(sourceRead.mock.callCount(), 1);
    assert.deepEqual(result.projected.kpis, []);
    const [table] = result.projected.tables;
    assert.equal(table!.rowCount, 2);
    assert.deepEqual(table!.columns.map((column) => column.key), [
      'wasteRecordId',
      'buildingId',
      'periodDate',
      'wasteType',
      'disposalMethod',
      'quantity',
      'uomId',
      'status',
    ]);
    assert.deepEqual(table!.rows.map((row) => row.wasteRecordId), [first.id, second.id]);
    assert.deepEqual(table!.rows[0], {
      wasteRecordId: first.id,
      buildingId: first.buildingId,
      periodDate: first.periodDate,
      wasteType: first.wasteType,
      disposalMethod: first.disposalMethod,
      quantity: first.quantity,
      uomId: first.uomId,
      status: first.status,
    });
    assert.equal(table!.rows[1]!.quantity, second.quantity);
    assert.ok(!('carbon' in table!.rows[0]!));
    assert.ok(!('co2e' in table!.rows[0]!));
    assert.ok(!('sourceRefs' in table!.rows[0]!));
  } finally {
    mock.restoreAll();
  }
});
