import ExcelJS from 'exceljs';
import {
  checksumBytes,
  CsvRendererError,
  neutralizeSpreadsheetFormula,
  safeFilename,
  validateReportingExportColumns,
  validateReportingExportRows,
} from './csv-renderer';
import type {
  PublicReportingExport,
  ReportingExportColumn,
  ReportingExportRow,
} from './reporting-export.types';

/** CR-BE-EXP-01 PART 03 — deterministic XLSX renderer over supplied data only. */

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const XLSX_CHECKSUM_ALGORITHM = 'SHA-256';

export type XlsxRendererOptions = {
  /** Optional display name; it never becomes a storage path or key. */
  filename?: string;
};

export type XlsxRenderResult = {
  bytes: Buffer;
  contentType: typeof XLSX_CONTENT_TYPE;
  filename: string;
  fileSize: number;
  checksum: string;
  checksumAlgorithm: typeof XLSX_CHECKSUM_ALGORITHM;
};

export type XlsxRendererErrorCode =
  | 'INVALID_SNAPSHOT'
  | 'NON_TABULAR_DATASET'
  | 'INVALID_TABLE'
  | 'UNSUPPORTED_CELL_VALUE'
  | 'UNSAFE_FILENAME';

export class XlsxRendererError extends Error {
  readonly code: XlsxRendererErrorCode;

  constructor(code: XlsxRendererErrorCode, message: string) {
    super(message);
    this.name = 'XlsxRendererError';
    this.code = code;
  }
}

/**
 * Renders one worksheet per supplied governed table from the canonical
 * reporting snapshot. ExcelJS is used only through its public workbook,
 * worksheet, row, and buffer APIs; no storage or archive state is touched.
 */
export async function renderReportingXlsx(
  snapshot: PublicReportingExport,
  options: XlsxRendererOptions = {},
): Promise<XlsxRenderResult> {
  const tables = validateSnapshotTables(snapshot);
  let filename: string;
  try {
    filename = safeFilename(
      options.filename,
      snapshot.metadata?.dataset,
      'report',
      'xlsx',
    );
  } catch (error) {
    if (error instanceof CsvRendererError && error.code === 'UNSAFE_FILENAME') {
      throw new XlsxRendererError('UNSAFE_FILENAME', error.message);
    }
    throw error;
  }

  const workbook = new ExcelJS.Workbook();
  const usedWorksheetNames = new Set<string>();

  tables.forEach((table, index) => {
    const worksheet = workbook.addWorksheet(
      sanitizeWorksheetName(table.key, index, usedWorksheetNames),
    );
    worksheet.addRow(
      table.columns.map((column) =>
        neutralizeSpreadsheetFormula(column.label),
      ),
    );
    for (const row of table.rows) {
      worksheet.addRow(
        table.columns.map((column) => serializeCell(row[column.key])),
      );
    }
  });

  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    bytes,
    contentType: XLSX_CONTENT_TYPE,
    filename,
    fileSize: bytes.length,
    checksum: checksumBytes(bytes),
    checksumAlgorithm: XLSX_CHECKSUM_ALGORITHM,
  };
}

type ValidatedXlsxTable = {
  key: string;
  columns: ReportingExportColumn[];
  rows: ReportingExportRow[];
};

function validateSnapshotTables(
  snapshot: PublicReportingExport,
): ValidatedXlsxTable[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.tables)) {
    throw new XlsxRendererError(
      'INVALID_SNAPSHOT',
      'XLSX rendering requires a canonical export snapshot with governed tables.',
    );
  }
  if (snapshot.tables.length === 0) {
    throw new XlsxRendererError(
      'NON_TABULAR_DATASET',
      'The supplied dataset has no governed tabular table for XLSX rendering.',
    );
  }

  return snapshot.tables.map((table, index) => {
    try {
      const candidate = table as unknown;
      if (!isRecord(candidate)) {
        throw new XlsxRendererError(
          'INVALID_TABLE',
          `Table ${index} must be a governed object.`,
        );
      }
      const columns = validateReportingExportColumns(candidate.columns);
      const rows = validateReportingExportRows(rowsValue(candidate), columns);
      return {
        key: typeof candidate.key === 'string' ? candidate.key : '',
        columns,
        rows,
      };
    } catch (error) {
      if (error instanceof XlsxRendererError) throw error;
      if (error instanceof CsvRendererError) {
        throw new XlsxRendererError(
          error.code === 'UNSUPPORTED_CELL_VALUE'
            ? 'UNSUPPORTED_CELL_VALUE'
            : error.code === 'NON_TABULAR_DATASET'
              ? 'NON_TABULAR_DATASET'
              : 'INVALID_TABLE',
          `Table ${index}: ${error.message}`,
        );
      }
      throw error;
    }
  });
}

function rowsValue(table: Record<string, unknown>): unknown {
  return table.rows;
}

function serializeCell(
  value: string | number | boolean | null | undefined,
): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    // Plain strings are deliberately supplied to ExcelJS, never formula
    // objects. The shared neutralization helper also protects strings that
    // begin with whitespace/control characters before a formula prefix.
    return neutralizeSpreadsheetFormula(value);
  }
  // The shared table validator already rejected non-finite numbers. Keeping a
  // number here preserves typed negative values as numeric XLSX cells.
  return value;
}

const XLSX_INVALID_SHEET_CHARS = /[:\\/?*\[\]]/g;
const MAX_WORKSHEET_NAME_LENGTH = 31;

function sanitizeWorksheetName(
  tableKey: string,
  index: number,
  usedNames: Set<string>,
): string {
  const fallback = `Sheet${index + 1}`;
  const base = tableKey
    .replace(XLSX_INVALID_SHEET_CHARS, '-')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^'+|'+$/g, '')
    .trim();
  let name = (base || fallback).slice(0, MAX_WORKSHEET_NAME_LENGTH);
  if (!name) name = fallback;

  const normalized = name.toLowerCase();
  if (!usedNames.has(normalized)) {
    usedNames.add(normalized);
    return name;
  }

  let suffixNumber = 2;
  while (true) {
    const suffix = `-${suffixNumber}`;
    const candidate = `${name.slice(0, MAX_WORKSHEET_NAME_LENGTH - suffix.length)}${suffix}`;
    const candidateKey = candidate.toLowerCase();
    if (!usedNames.has(candidateKey)) {
      usedNames.add(candidateKey);
      return candidate;
    }
    suffixNumber += 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
