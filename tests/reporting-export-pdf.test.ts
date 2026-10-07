import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { checksumBytes } from '../src/modules/reporting-export/csv-renderer';
import {
  PdfRendererError,
  renderReportingPdf,
} from '../src/modules/reporting-export/pdf-renderer';
import type {
  PublicReportingExport,
  ReportingExportColumn,
  ReportingExportRow,
  ReportingExportTable,
} from '../src/modules/reporting-export/reporting-export.types';

function makeTable(
  key: string,
  columns: ReportingExportColumn[],
  rows: ReportingExportRow[],
  label = key || 'Table',
): ReportingExportTable {
  return { key, label, columns, rows, rowCount: rows.length };
}

function snapshot(tables: ReportingExportTable[]): PublicReportingExport {
  return {
    metadata: {
      dataset: 'WORKFORCE',
      datasetLabel: 'Workforce',
      buildingId: null,
      buildingScope: [],
      period: {
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-08-24T00:00:00.000Z',
      },
      filters: { status: 'ACTIVE' },
      asOf: '2026-08-24T00:00:00.000Z',
    },
    kpis: [],
    tables,
    generatedAt: '2026-08-24T00:00:01.000Z',
  };
}

async function loadPdf(bytes: Buffer): Promise<PDFDocument> {
  return PDFDocument.load(bytes);
}

test('generates a valid PDF with governed table structure and metadata', async () => {
  const result = await renderReportingPdf(
    snapshot([
      makeTable(
        'summary',
        [
          { key: 'name', label: 'Name', type: 'STRING' },
          { key: 'count', label: 'Count', type: 'NUMBER' },
          { key: 'active', label: 'Active', type: 'BOOLEAN' },
          { key: 'optional', label: 'Optional', type: 'STRING' },
        ],
        [
          { name: 'second', count: 2, active: false, optional: null },
          { name: 'first', count: 1, active: true, optional: 'present' },
        ],
        'Operations Summary',
      ),
    ]),
    { filename: 'Quarterly Operations.pdf' },
  );
  const pdf = await loadPdf(result.bytes);

  assert.equal(result.bytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(pdf.getPageCount(), 1);
  assert.ok(pdf.getPages()[0]!.getWidth() > 595);
  assert.ok(pdf.getPages()[0]!.getHeight() > 841);
  assert.equal(result.contentType, 'application/pdf');
  assert.equal(result.filename, 'Quarterly-Operations.pdf');
  assert.equal(result.fileSize, result.bytes.length);
  assert.equal(result.checksum, checksumBytes(result.bytes));
  assert.match(result.checksum, /^[0-9a-f]{64}$/);
});

test('preserves deterministic logical page structure for multiple supplied tables', async () => {
  const source = snapshot([
    makeTable(
      'first',
      [{ key: 'value', label: 'Value', type: 'STRING' }],
      [{ value: 'one' }],
    ),
    makeTable(
      'second',
      [{ key: 'value', label: 'Value', type: 'STRING' }],
      [{ value: 'two' }],
    ),
  ]);

  const first = await loadPdf((await renderReportingPdf(source)).bytes);
  const second = await loadPdf((await renderReportingPdf(source)).bytes);

  assert.equal(first.getPageCount(), second.getPageCount());
  assert.equal(first.getPages().length, 1);
  assert.deepEqual(
    first.getPages().map((page) => [page.getWidth(), page.getHeight()]),
    second.getPages().map((page) => [page.getWidth(), page.getHeight()]),
  );
});

test('handles strings, numbers, booleans, nulls, text escaping, and UTF-8 input safely', async () => {
  const result = await renderReportingPdf(
    snapshot([
      makeTable(
        'values',
        [
          { key: 'text', label: 'Text', type: 'STRING' },
          { key: 'number', label: 'Number', type: 'NUMBER' },
          { key: 'flag', label: 'Flag', type: 'BOOLEAN' },
          { key: 'empty', label: 'Empty', type: 'STRING' },
          { key: 'date', label: 'Date', type: 'DATE' },
        ],
        [
          {
            text: '<script>alert("x")</script> (safe) \\ München 東京\nnext',
            number: -42,
            flag: true,
            empty: null,
            date: '2026-08-24T00:00:00.000Z',
          },
        ],
      ),
    ]),
  );

  const pdf = await loadPdf(result.bytes);
  assert.equal(pdf.getPageCount(), 1);
  assert.ok(result.bytes.length > 0);
});

test('continues a long table across multiple pages', async () => {
  const rows: ReportingExportRow[] = Array.from({ length: 140 }, (_, index) => ({
    index,
    description: `Row ${index} with a bounded description`,
  }));
  const result = await renderReportingPdf(
    snapshot([
      makeTable(
        'long-table',
        [
          { key: 'index', label: 'Index', type: 'NUMBER' },
          { key: 'description', label: 'Description', type: 'STRING' },
        ],
        rows,
      ),
    ]),
  );
  const pdf = await loadPdf(result.bytes);

  assert.ok(pdf.getPageCount() > 1);
  assert.ok(pdf.getPageCount() <= 200);
});

test('rejects nested cell values and unsafe filenames', async () => {
  const nested = snapshot([
    makeTable(
      'nested',
      [{ key: 'value', label: 'Value', type: 'STRING' }],
      [{ value: { nested: true } as unknown as string }],
    ),
  ]);

  await assert.rejects(
    () => renderReportingPdf(nested),
    (error: unknown) =>
      error instanceof PdfRendererError && error.code === 'UNSUPPORTED_CELL_VALUE',
  );

  const simple = snapshot([
    makeTable(
      'simple',
      [{ key: 'value', label: 'Value', type: 'STRING' }],
      [{ value: 'x' }],
    ),
  ]);
  await assert.rejects(
    () => renderReportingPdf(simple, { filename: '../unsafe.pdf' }),
    (error: unknown) =>
      error instanceof PdfRendererError && error.code === 'UNSAFE_FILENAME',
  );
});
