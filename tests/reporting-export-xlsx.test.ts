import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { checksumBytes } from '../src/modules/reporting-export/csv-renderer';
import {
  XlsxRendererError,
  renderReportingXlsx,
} from '../src/modules/reporting-export/xlsx-renderer';
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
): ReportingExportTable {
  return { key, label: key || 'Table', columns, rows, rowCount: rows.length };
}

function snapshot(tables: ReportingExportTable[]): PublicReportingExport {
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
    tables,
    generatedAt: '2026-08-24T00:00:01.000Z',
  };
}

async function loadWorkbook(bytes: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook;
}

function logicalRows(worksheet: ExcelJS.Worksheet, width: number): unknown[][] {
  return Array.from({ length: worksheet.rowCount }, (_, rowIndex) =>
    Array.from({ length: width }, (_, columnIndex) => {
      const value = worksheet.getCell(rowIndex + 1, columnIndex + 1).value;
      return value == null ? null : value;
    }),
  );
}

test('generates one logical worksheet per governed table with typed values and order preserved', async () => {
  const columns: ReportingExportColumn[] = [
    { key: 'name', label: 'Name', type: 'STRING' },
    { key: 'count', label: 'Count', type: 'NUMBER' },
    { key: 'active', label: 'Active', type: 'BOOLEAN' },
    { key: 'asOf', label: 'As Of', type: 'DATE' },
    { key: 'optional', label: 'Optional', type: 'STRING' },
  ];
  const source = snapshot([
    makeTable(
      'summary',
      columns,
      [
        {
          name: 'second',
          count: 2,
          active: false,
          asOf: '2026-08-24T00:00:00.000Z',
          optional: null,
        },
        {
          name: 'first',
          count: 1,
          active: true,
          asOf: '2026-08-25T00:00:00.000Z',
          optional: 'present',
        },
      ],
    ),
    makeTable(
      'details',
      [{ key: 'label', label: 'Label', type: 'STRING' }],
      [{ label: '東京' }],
    ),
  ]);

  const result = await renderReportingXlsx(source, {
    filename: 'Quarterly Operations.xlsx',
  });
  const workbook = await loadWorkbook(result.bytes);

  assert.equal(workbook.worksheets.length, 2);
  assert.deepEqual(
    workbook.worksheets.map((worksheet) => worksheet.name),
    ['summary', 'details'],
  );
  assert.deepEqual(logicalRows(workbook.worksheets[0]!, 5), [
    ['Name', 'Count', 'Active', 'As Of', 'Optional'],
    ['second', 2, false, '2026-08-24T00:00:00.000Z', null],
    ['first', 1, true, '2026-08-25T00:00:00.000Z', 'present'],
  ]);
  assert.ok(workbook.worksheets[0]!.getCell(2, 5).value == null);
  assert.deepEqual(logicalRows(workbook.worksheets[1]!, 1), [
    ['Label'],
    ['東京'],
  ]);
  assert.equal(result.filename, 'Quarterly-Operations.xlsx');
  assert.equal(
    result.contentType,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  assert.equal(result.fileSize, result.bytes.length);
  assert.equal(result.checksum, checksumBytes(result.bytes));
  assert.match(result.checksum, /^[0-9a-f]{64}$/);
});

test('keeps logical workbook structure deterministic without requiring identical ZIP metadata', async () => {
  const source = snapshot([
    makeTable(
      'long-sheet-name-that-needs-truncation-2026',
      [{ key: 'value', label: 'Value', type: 'STRING' }],
      [{ value: 'A' }, { value: 'B' }],
    ),
    makeTable(
      'second',
      [{ key: 'value', label: 'Value', type: 'STRING' }],
      [{ value: 'C' }],
    ),
  ]);

  const first = await loadWorkbook((await renderReportingXlsx(source)).bytes);
  const second = await loadWorkbook((await renderReportingXlsx(source)).bytes);

  assert.deepEqual(
    first.worksheets.map((worksheet) => worksheet.name),
    second.worksheets.map((worksheet) => worksheet.name),
  );
  assert.deepEqual(
    first.worksheets.map((worksheet) => logicalRows(worksheet, 1)),
    second.worksheets.map((worksheet) => logicalRows(worksheet, 1)),
  );
  assert.ok(first.worksheets[0]!.name.length <= 31);
});

test('sanitizes invalid and empty worksheet names deterministically', async () => {
  const source = snapshot([
    makeTable(
      'Operations:Daily/2026?*[] with a name that is too long',
      [{ key: 'value', label: 'Value', type: 'STRING' }],
      [{ value: 'one' }],
    ),
    makeTable(
      '',
      [{ key: 'value', label: 'Value', type: 'STRING' }],
      [{ value: 'two' }],
    ),
  ]);

  const workbook = await loadWorkbook((await renderReportingXlsx(source)).bytes);
  const names = workbook.worksheets.map((worksheet) => worksheet.name);

  assert.equal(names.length, 2);
  assert.ok(names[0]!.length <= 31);
  assert.doesNotMatch(names[0]!, /[:\\/?*\[\]]/u);
  assert.equal(names[1], 'Sheet2');
});

test('neutralizes formula-like strings while preserving typed negative numbers', async () => {
  const source = snapshot([
    makeTable(
      'safety',
      [
        { key: 'value', label: 'Value', type: 'STRING' },
        { key: 'numeric', label: 'Numeric', type: 'NUMBER' },
      ],
      [
        { value: '=SUM(A1:A2)', numeric: -42 },
        { value: '  +CMD("bad")', numeric: 7 },
        { value: '\t-2+3', numeric: 8 },
        { value: '\u0001@evil', numeric: 9 },
      ],
    ),
  ]);

  const workbook = await loadWorkbook((await renderReportingXlsx(source)).bytes);
  const worksheet = workbook.worksheets[0]!;

  assert.equal(worksheet.getCell(2, 1).value, "'=SUM(A1:A2)");
  assert.equal(worksheet.getCell(3, 1).value, "'  +CMD(\"bad\")");
  assert.equal(worksheet.getCell(4, 1).value, "'\t-2+3");
  assert.equal(worksheet.getCell(5, 1).value, "'\u0001@evil");
  assert.equal(worksheet.getCell(2, 2).value, -42);
  assert.equal(typeof worksheet.getCell(2, 2).value, 'number');
});

test('rejects nested cells and unsafe filenames', async () => {
  const nested = snapshot([
    makeTable(
      'nested',
      [{ key: 'value', label: 'Value', type: 'STRING' }],
      [{ value: { nested: true } as unknown as string }],
    ),
  ]);

  await assert.rejects(
    () => renderReportingXlsx(nested),
    (error: unknown) =>
      error instanceof XlsxRendererError && error.code === 'UNSUPPORTED_CELL_VALUE',
  );

  const simple = snapshot([
    makeTable(
      'simple',
      [{ key: 'value', label: 'Value', type: 'STRING' }],
      [{ value: 'x' }],
    ),
  ]);
  await assert.rejects(
    () => renderReportingXlsx(simple, { filename: '../unsafe.xlsx' }),
    (error: unknown) =>
      error instanceof XlsxRendererError && error.code === 'UNSAFE_FILENAME',
  );
});
