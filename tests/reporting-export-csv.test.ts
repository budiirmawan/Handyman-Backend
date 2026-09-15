import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CsvRendererError,
  renderReportingCsv,
  renderReportingCsvTable,
} from '../src/modules/reporting-export/csv-renderer';
import type {
  PublicReportingExport,
  ReportingExportTable,
} from '../src/modules/reporting-export/reporting-export.types';

function table(
  columns: ReportingExportTable['columns'],
  rows: ReportingExportTable['rows'],
  key = 'rows',
): ReportingExportTable {
  return { key, label: 'Rows', columns, rows, rowCount: rows.length };
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

test('renders deterministic column and supplied row order with stable metadata', () => {
  const source = snapshot([
    table(
      [
        { key: 'name', label: 'Name', type: 'STRING' },
        { key: 'count', label: 'Count', type: 'NUMBER' },
      ],
      [
        { name: 'second', count: 2 },
        { name: 'first', count: 1 },
      ],
      'members',
    ),
  ]);

  const first = renderReportingCsv(source);
  const second = renderReportingCsv(source);

  assert.equal(first.text, 'Name,Count\r\nsecond,2\r\nfirst,1\r\n');
  assert.equal(first.text, second.text);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.filename, 'WORKFORCE-members.csv');
  assert.equal(first.contentType, 'text/csv; charset=utf-8');
  assert.equal(first.fileSize, Buffer.byteLength(first.text, 'utf8'));
  assert.equal(first.checksum, second.checksum);
  assert.match(first.checksum, /^[0-9a-f]{64}$/);
});

test('escapes commas, double-quotes, CR/LF, and distinguishes null from empty string', () => {
  const result = renderReportingCsvTable({
    key: 'values',
    columns: [{ key: 'value', label: 'Value', type: 'STRING' }],
    rows: [
      { value: 'comma, value' },
      { value: 'quote " value' },
      { value: 'line\nvalue' },
      { value: 'carriage\rreturn' },
      { value: null },
      { value: '' },
    ],
  });

  assert.equal(
    result.text,
    [
      'Value',
      '"comma, value"',
      '"quote "" value"',
      '"line\nvalue"',
      '"carriage\rreturn"',
      '',
      '""',
      '',
    ].join('\r\n'),
  );
});

test('preserves supplied ISO date/time text without locale-dependent conversion', () => {
  const result = renderReportingCsvTable({
    key: 'dates',
    columns: [{ key: 'asOf', label: 'As Of', type: 'DATE' }],
    rows: [{ asOf: '2026-08-24T00:00:00.000Z' }],
  });

  assert.equal(result.text, 'As Of\r\n2026-08-24T00:00:00.000Z\r\n');
});

test('emits UTF-8 bytes without locale-dependent conversion', () => {
  const result = renderReportingCsvTable({
    key: 'locations',
    columns: [{ key: 'name', label: 'Location', type: 'STRING' }],
    rows: [{ name: 'München, 東京' }],
  });

  assert.equal(result.bytes.toString('utf8'), result.text);
  assert.equal(result.fileSize, Buffer.byteLength('Location\r\n"München, 東京"\r\n', 'utf8'));
  assert.match(result.text, /"München, 東京"/u);
});

test('neutralizes formula-like strings including leading whitespace and controls', () => {
  const result = renderReportingCsvTable({
    key: 'formula-safety',
    columns: [
      { key: 'value', label: 'Value', type: 'STRING' },
      { key: 'numeric', label: 'Numeric', type: 'NUMBER' },
    ],
    rows: [
      { value: '=SUM(A1:A2)', numeric: -42 },
      { value: '  +CMD("bad")', numeric: 7 },
      { value: '\t-2+3', numeric: 8 },
      { value: '\u0001@evil', numeric: 9 },
      { value: 'ordinary', numeric: 10 },
    ],
  });

  assert.match(result.text, /'=SUM\(A1:A2\),-42\r\n/u);
  assert.match(result.text, /"'  \+CMD\(""bad""\)",7\r\n/u);
  assert.match(result.text, /"'\t-2\+3",8\r\n/u);
  assert.match(result.text, /"'\u0001@evil",9\r\n/u);
  assert.match(result.text, /ordinary,10\r\n/u);
  assert.doesNotMatch(result.text, /,'-42\r\n/u);
});

test('requires an explicit table for multi-table snapshots and rejects non-tabular data', () => {
  const columns = [{ key: 'value', label: 'Value', type: 'STRING' as const }];
  const multi = snapshot([
    table(columns, [{ value: 'one' }], 'one'),
    table(columns, [{ value: 'two' }], 'two'),
  ]);

  assert.throws(
    () => renderReportingCsv(multi),
    (error: unknown) =>
      error instanceof CsvRendererError && error.code === 'TABLE_SELECTION_REQUIRED',
  );
  assert.throws(
    () => renderReportingCsv(snapshot([])),
    (error: unknown) =>
      error instanceof CsvRendererError && error.code === 'NON_TABULAR_DATASET',
  );
  assert.throws(
    () =>
      renderReportingCsvTable({
        key: 'nested',
        columns,
        rows: [{ value: { nested: true } as unknown as string }],
      }),
    (error: unknown) =>
      error instanceof CsvRendererError && error.code === 'UNSUPPORTED_CELL_VALUE',
  );
});

test('rejects unsafe governed columns and unsafe filename input', () => {
  assert.throws(
    () =>
      renderReportingCsvTable({
        key: 'bad',
        columns: [
          { key: 'value', label: 'Value', type: 'STRING' },
          { key: 'value', label: 'Duplicate', type: 'STRING' },
        ],
        rows: [{ value: 'x' }],
      }),
    (error: unknown) =>
      error instanceof CsvRendererError && error.code === 'INVALID_COLUMN_DEFINITION',
  );

  assert.throws(
    () =>
      renderReportingCsv(snapshot([
        table(
          [{ key: 'value', label: 'Value', type: 'STRING' }],
          [{ value: 'x' }],
        ),
      ]), { filename: '../unsafe.csv' }),
    (error: unknown) =>
      error instanceof CsvRendererError && error.code === 'UNSAFE_FILENAME',
  );
});
