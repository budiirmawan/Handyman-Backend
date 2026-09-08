import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { checksumBytes } from '../src/modules/reporting-export/csv-renderer';
import {
  renderReportArchiveArtifact,
} from '../src/modules/reporting-archives/reporting-archive-generation.service';
import {
  getReportingExportDatasetAdapter,
  REPORTING_EXPORT_DATASET_REGISTRY,
} from '../src/modules/reporting-export/reporting-export.registry';
import type {
  PublicReportingExport,
  ReportingExportTable,
} from '../src/modules/reporting-export/reporting-export.types';

function snapshot(): PublicReportingExport {
  const table: ReportingExportTable = {
    key: 'summary',
    label: 'Summary',
    columns: [
      { key: 'label', label: 'Label', type: 'STRING' },
      { key: 'count', label: 'Count', type: 'NUMBER' },
    ],
    rows: [
      { label: 'second', count: 2 },
      { label: 'first', count: 1 },
    ],
    rowCount: 2,
  };
  return {
    metadata: {
      dataset: 'WORKFORCE',
      datasetLabel: 'Workforce',
      buildingId: null,
      buildingScope: [],
      period: { dateFrom: null, dateTo: null },
      filters: {},
      asOf: '2026-08-24T00:00:00.000Z',
    },
    kpis: [],
    tables: [table],
    generatedAt: '2026-08-24T00:00:01.000Z',
  };
}

test('registers the supported dataset adapters without a second calculation authority', () => {
  assert.deepEqual(Object.keys(REPORTING_EXPORT_DATASET_REGISTRY).sort(), [
    'MANAGEMENT_OPERATIONS_COMMAND_CENTER',
    'SECURITY_FINDING_INCIDENT',
    'SECURITY_PATROL',
    'UTILITY',
    'VENDOR_TENANT',
    'WORKFORCE',
  ]);
  for (const adapter of Object.values(REPORTING_EXPORT_DATASET_REGISTRY)) {
    assert.ok(adapter.sourceAuthority);
    assert.equal(typeof adapter.load, 'function');
  }
  assert.throws(
    () => getReportingExportDatasetAdapter('ESG' as never),
    /dataset must be one of/u,
  );
});

test('dispatches every requested format from the same canonical snapshot', async () => {
  const source = snapshot();
  const outputs = await Promise.all(
    (['JSON', 'CSV', 'XLSX', 'PDF'] as const).map((format) =>
      renderReportArchiveArtifact({ dataset: 'WORKFORCE', format }, source),
    ),
  );

  assert.deepEqual(
    outputs.map((output) => output.contentType),
    [
      'application/json; charset=utf-8',
      'text/csv; charset=utf-8',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/pdf',
    ],
  );
  outputs.forEach((output) => {
    assert.ok(output.bytes.length > 0);
    assert.equal(output.fileSize, output.bytes.length);
    assert.equal(output.checksum, checksumBytes(output.bytes));
    assert.match(output.filename, /^[A-Za-z0-9_-]+\.(json|csv|xlsx|pdf)$/u);
  });

  assert.deepEqual(JSON.parse(outputs[0]!.bytes.toString('utf8')), source);
  assert.match(outputs[1]!.bytes.toString('utf8'), /^Label,Count\r\nsecond,2\r\nfirst,1\r\n/u);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(outputs[2]!.bytes);
  assert.equal(workbook.worksheets.length, 1);
  assert.equal(workbook.worksheets[0]!.name, 'summary');

  const pdf = await PDFDocument.load(outputs[3]!.bytes);
  assert.equal(pdf.getPageCount(), 1);
});

test('rejects unsupported format identity without a fallback renderer', async () => {
  await assert.rejects(
    () =>
      renderReportArchiveArtifact(
        { dataset: 'WORKFORCE', format: 'DOCX' as never },
        snapshot(),
      ),
    /Unsupported report archive format/u,
  );
});
