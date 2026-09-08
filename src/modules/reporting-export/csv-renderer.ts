import { createHash } from 'node:crypto';
import {
  REPORTING_EXPORT_COLUMN_TYPES,
  type PublicReportingExport,
  type ReportingExportColumn,
  type ReportingExportRow,
  type ReportingExportTable,
} from './reporting-export.types';

/** CR-BE-EXP-01 PART 02 — deterministic CSV renderer over supplied data only. */

export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
export const CSV_LINE_ENDING = '\r\n';
export const CSV_CHECKSUM_ALGORITHM = 'SHA-256';

export type CsvRendererOptions = {
  /** Required for snapshots with more than one governed table. */
  tableKey?: string;
  /** Optional display name; it never becomes a storage path or key. */
  filename?: string;
};

export type CsvRenderResult = {
  text: string;
  bytes: Buffer;
  contentType: typeof CSV_CONTENT_TYPE;
  filename: string;
  fileSize: number;
  checksum: string;
  checksumAlgorithm: typeof CSV_CHECKSUM_ALGORITHM;
};

export type CsvRendererErrorCode =
  | 'INVALID_SNAPSHOT'
  | 'NON_TABULAR_DATASET'
  | 'TABLE_SELECTION_REQUIRED'
  | 'TABLE_NOT_FOUND'
  | 'INVALID_COLUMN_DEFINITION'
  | 'INVALID_ROW'
  | 'UNSUPPORTED_CELL_VALUE'
  | 'UNSAFE_FILENAME';

export class CsvRendererError extends Error {
  readonly code: CsvRendererErrorCode;

  constructor(code: CsvRendererErrorCode, message: string) {
    super(message);
    this.name = 'CsvRendererError';
    this.code = code;
  }
}

/**
 * Renders one governed table from the canonical export snapshot.
 *
 * This function intentionally has no database, authorization, storage, or
 * archive dependency. It preserves the supplied row order and column order;
 * it only serializes already-governed scalar values.
 */
export function renderReportingCsv(
  snapshot: PublicReportingExport,
  options: CsvRendererOptions = {},
): CsvRenderResult {
  const table = selectTable(snapshot, options.tableKey);
  const filename = safeFilename(
    options.filename,
    snapshot.metadata?.dataset,
    table.key,
  );
  return renderReportingCsvTable(table, { filename });
}

/** Renders a single already-selected governed table without inspecting a dataset. */
export function renderReportingCsvTable(
  table: Pick<ReportingExportTable, 'key' | 'columns' | 'rows'>,
  options: Pick<CsvRendererOptions, 'filename'> = {},
): CsvRenderResult {
  const validated = validateReportingExportTable(table);
  const { key: tableKey, columns, rows } = validated;
  const header = columns
    .map((column) => csvCell(neutralizeSpreadsheetFormula(column.label)))
    .join(',');
  const body = rows.map((row) =>
    columns.map((column) => serializeCell(row[column.key])).join(','),
  );
  const text = [header, ...body].join(CSV_LINE_ENDING) + CSV_LINE_ENDING;
  const bytes = Buffer.from(text, 'utf8');

  return {
    text,
    bytes,
    contentType: CSV_CONTENT_TYPE,
    filename: safeFilename(options.filename, 'report', tableKey),
    fileSize: bytes.length,
    checksum: checksumBytes(bytes),
    checksumAlgorithm: CSV_CHECKSUM_ALGORITHM,
  };
}

export type ValidatedReportingExportTable = {
  key: string;
  columns: ReportingExportColumn[];
  rows: ReportingExportRow[];
};

/** Shared flat-table validation used by all tabular renderers. */
export function validateReportingExportTable(
  table: Pick<ReportingExportTable, 'key' | 'columns' | 'rows'>,
): ValidatedReportingExportTable {
  if (!isRecord(table)) {
    throw new CsvRendererError(
      'INVALID_SNAPSHOT',
      'A governed reporting table must be an object.',
    );
  }
  const key = validateTableKey(table.key);
  const columns = validateColumns(table.columns);
  const rows = validateRows(table.rows, columns);
  return { key, columns, rows };
}

/** Shared governed-column validation for other format renderers. */
export function validateReportingExportColumns(
  columns: unknown,
): ReportingExportColumn[] {
  return validateColumns(columns);
}

/** Shared flat-row validation for other format renderers. */
export function validateReportingExportRows(
  rows: unknown,
  columns: ReportingExportColumn[],
): ReportingExportRow[] {
  return validateRows(rows, columns);
}

function selectTable(
  snapshot: PublicReportingExport,
  tableKey: string | undefined,
): ReportingExportTable {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.tables)) {
    throw new CsvRendererError(
      'INVALID_SNAPSHOT',
      'CSV rendering requires a canonical export snapshot with governed tables.',
    );
  }
  if (snapshot.tables.length === 0) {
    throw new CsvRendererError(
      'NON_TABULAR_DATASET',
      'The supplied dataset has no governed tabular table for CSV rendering.',
    );
  }
  if (tableKey !== undefined) {
    const table = snapshot.tables.find((candidate) => candidate?.key === tableKey);
    if (!table) {
      throw new CsvRendererError(
        'TABLE_NOT_FOUND',
        `No governed CSV table exists for tableKey ${JSON.stringify(tableKey)}.`,
      );
    }
    return table;
  }
  if (snapshot.tables.length !== 1) {
    throw new CsvRendererError(
      'TABLE_SELECTION_REQUIRED',
      'A tableKey is required when the dataset exposes more than one governed table.',
    );
  }
  return snapshot.tables[0]!;
}

function validateTableKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)
  ) {
    throw new CsvRendererError(
      'INVALID_COLUMN_DEFINITION',
      'The table key must be a safe governed identifier.',
    );
  }
  return value;
}

function validateColumns(
  columns: unknown,
): ReportingExportColumn[] {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new CsvRendererError(
      'NON_TABULAR_DATASET',
      'CSV rendering requires at least one governed column.',
    );
  }

  const seen = new Set<string>();
  return columns.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new CsvRendererError(
        'INVALID_COLUMN_DEFINITION',
        `Column ${index} must be a governed object.`,
      );
    }
    const unknownKeys = Object.keys(candidate).filter(
      (key) => !['key', 'label', 'type'].includes(key),
    );
    const key = candidate.key;
    const label = candidate.label;
    const type = candidate.type;
    if (unknownKeys.length > 0) {
      throw new CsvRendererError(
        'INVALID_COLUMN_DEFINITION',
        `Column ${index} contains unsupported definition fields.`,
      );
    }
    if (
      typeof key !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key) ||
      seen.has(key)
    ) {
      throw new CsvRendererError(
        'INVALID_COLUMN_DEFINITION',
        `Column ${index} has an invalid or duplicate key.`,
      );
    }
    if (
      typeof label !== 'string' ||
      label.length === 0 ||
      label.length > 256 ||
      label.includes('\u0000') ||
      /[\r\n]/.test(label)
    ) {
      throw new CsvRendererError(
        'INVALID_COLUMN_DEFINITION',
        `Column ${key} has an invalid label.`,
      );
    }
    if (!isColumnType(type)) {
      throw new CsvRendererError(
        'INVALID_COLUMN_DEFINITION',
        `Column ${key} has an unsupported value type.`,
      );
    }
    seen.add(key);
    return { key, label, type };
  });
}

function validateRows(
  rows: unknown,
  columns: ReportingExportColumn[],
): ReportingExportRow[] {
  if (!Array.isArray(rows)) {
    throw new CsvRendererError(
      'NON_TABULAR_DATASET',
      'CSV rendering requires an array of governed rows.',
    );
  }

  return rows.map((candidate, rowIndex) => {
    if (!isRecord(candidate)) {
      throw new CsvRendererError(
        'INVALID_ROW',
        `Row ${rowIndex} must be a flat object; nested data is not flattened.`,
      );
    }
    for (const column of columns) {
      const value = candidate[column.key];
      if (
        value !== undefined &&
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw new CsvRendererError(
          'UNSUPPORTED_CELL_VALUE',
          `Row ${rowIndex}, column ${column.key} is nested or otherwise unsupported.`,
        );
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new CsvRendererError(
          'UNSUPPORTED_CELL_VALUE',
          `Row ${rowIndex}, column ${column.key} must contain a finite number.`,
        );
      }
      if (typeof value === 'string' && value.includes('\u0000')) {
        throw new CsvRendererError(
          'UNSUPPORTED_CELL_VALUE',
          `Row ${rowIndex}, column ${column.key} contains a NUL character.`,
        );
      }
    }
    return candidate as ReportingExportRow;
  });
}

function serializeCell(value: string | number | boolean | null | undefined): string {
  if (value === undefined || value === null) {
    // Governed null representation: an empty unquoted cell. An empty string
    // remains distinguishable as a quoted empty string below.
    return '';
  }
  if (typeof value === 'string') {
    return csvCell(neutralizeSpreadsheetFormula(value), value.length === 0);
  }
  // Typed numeric negatives remain ordinary numeric CSV values; only strings
  // receive spreadsheet-formula neutralization.
  return csvCell(String(value));
}

function csvCell(value: string, forceQuote = false): string {
  const quoted =
    forceQuote || /[",\r\n]/.test(value) || hasControlCharacter(value);
  if (!quoted) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function neutralizeSpreadsheetFormula(value: string): string {
  const characters = Array.from(value);
  const firstVisible = characters.find((character) => !isLeadingIgnorable(character));
  if (firstVisible && '=+-@'.includes(firstVisible)) {
    return `'${value}`;
  }
  return value;
}

function isLeadingIgnorable(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    /\s/u.test(character) ||
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function isColumnType(value: unknown): value is ReportingExportColumn['type'] {
  return REPORTING_EXPORT_COLUMN_TYPES.includes(
    value as ReportingExportColumn['type'],
  );
}

export function safeFilename(
  requested: string | undefined,
  dataset: unknown,
  tableKey: unknown,
  extension = 'csv',
): string {
  if (!/^[a-z0-9]{1,8}$/i.test(extension)) {
    throw new CsvRendererError('UNSAFE_FILENAME', 'Filename extension is not safe.');
  }
  const normalizedExtension = extension.toLowerCase();
  const raw = requested ?? `${String(dataset || 'report')}-${String(tableKey || 'table')}.${normalizedExtension}`;
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > 220 ||
    /[\u0000-\u001f\u007f]/.test(raw) ||
    /[\\/]/.test(raw) ||
    raw.includes('..')
  ) {
    throw new CsvRendererError(
      'UNSAFE_FILENAME',
      'Filename must be a single safe file name without path or control characters.',
    );
  }

  const withoutExtension = raw.replace(
    new RegExp(`\\.${normalizedExtension}$`, 'i'),
    '',
  );
  const slug = withoutExtension
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
  if (!slug || slug === '.' || slug === '..') {
    throw new CsvRendererError('UNSAFE_FILENAME', 'CSV filename has no safe name.');
  }
  return `${slug}.${normalizedExtension}`;
}

export function checksumBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
