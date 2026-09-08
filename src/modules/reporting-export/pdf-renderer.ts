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
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';

/** CR-BE-EXP-01 PART 04 — deterministic PDF renderer over supplied data only. */

export const PDF_CONTENT_TYPE = 'application/pdf';
export const PDF_CHECKSUM_ALGORITHM = 'SHA-256';

const PAGE_WIDTH = 595.28; // A4, points
const PAGE_HEIGHT = 841.89;
const MARGIN = 36;
const FOOTER_HEIGHT = 24;
const CONTENT_BOTTOM = MARGIN + FOOTER_HEIGHT;
const TITLE_SIZE = 16;
const META_SIZE = 8;
const SECTION_SIZE = 11;
const HEADER_SIZE = 8;
const CELL_SIZE = 7;
const LINE_HEIGHT = 9;
const CELL_PADDING = 3;
const SECTION_GAP = 12;
const MAX_CELL_LINES = 3;
const MAX_TABLES = 100;
const MAX_COLUMNS = 50;
const MAX_PDF_PAGES = 200;

export type PdfRendererOptions = {
  /** Optional display name; it never becomes a storage path or key. */
  filename?: string;
};

export type PdfRenderResult = {
  bytes: Buffer;
  contentType: typeof PDF_CONTENT_TYPE;
  filename: string;
  fileSize: number;
  checksum: string;
  checksumAlgorithm: typeof PDF_CHECKSUM_ALGORITHM;
};

export type PdfRendererErrorCode =
  | 'INVALID_SNAPSHOT'
  | 'NON_TABULAR_DATASET'
  | 'INVALID_TABLE'
  | 'UNSUPPORTED_CELL_VALUE'
  | 'UNSAFE_FILENAME'
  | 'PDF_CONTENT_TOO_LARGE';

export class PdfRendererError extends Error {
  readonly code: PdfRendererErrorCode;

  constructor(code: PdfRendererErrorCode, message: string) {
    super(message);
    this.name = 'PdfRendererError';
    this.code = code;
  }
}

type ValidatedPdfTable = {
  key: string;
  label: string;
  columns: ReportingExportColumn[];
  rows: ReportingExportRow[];
};

/**
 * Renders a presentation-oriented PDF from one canonical snapshot. The
 * renderer uses only pdf-lib's public document/page/font drawing APIs and
 * never performs database, authorization, storage, or archive work.
 */
export async function renderReportingPdf(
  snapshot: PublicReportingExport,
  options: PdfRendererOptions = {},
): Promise<PdfRenderResult> {
  const tables = validateSnapshotTables(snapshot);
  let filename: string;
  try {
    filename = safeFilename(
      options.filename,
      snapshot.metadata?.dataset,
      'report',
      'pdf',
    );
  } catch (error) {
    if (error instanceof CsvRendererError && error.code === 'UNSAFE_FILENAME') {
      throw new PdfRendererError('UNSAFE_FILENAME', error.message);
    }
    throw error;
  }

  const document = await PDFDocument.create();
  const regularFont = await document.embedFont(StandardFonts.Helvetica);
  const boldFont = await document.embedFont(StandardFonts.HelveticaBold);
  const pages: PDFPage[] = [];
  let page: PDFPage | null = null;
  let cursorY = 0;

  const addPage = (): PDFPage => {
    if (pages.length >= MAX_PDF_PAGES) {
      throw new PdfRendererError(
        'PDF_CONTENT_TOO_LARGE',
        `PDF output must not exceed ${MAX_PDF_PAGES} pages.`,
      );
    }
    const created = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page = created;
    pages.push(created);
    cursorY = PAGE_HEIGHT - MARGIN;
    return created;
  };

  const drawReportHeader = (): void => {
    const current = page ?? addPage();
    const metadata = snapshot.metadata;
    const title = pdfText(metadata?.datasetLabel || metadata?.dataset || 'Report');
    current.drawText(title || 'Report', {
      x: MARGIN,
      y: cursorY - TITLE_SIZE,
      size: TITLE_SIZE,
      font: boldFont,
      color: rgb(0.08, 0.12, 0.18),
    });
    cursorY -= TITLE_SIZE + 10;

    const metadataLines = [
      `Generated: ${pdfText(snapshot.generatedAt)}`,
      `As of: ${pdfText(metadata?.asOf ?? '')}`,
      `Period: ${pdfText(metadata?.period?.dateFrom ?? '')} to ${pdfText(metadata?.period?.dateTo ?? '')}`,
    ];
    for (const line of metadataLines) {
      current.drawText(line, {
        x: MARGIN,
        y: cursorY - META_SIZE,
        size: META_SIZE,
        font: regularFont,
        color: rgb(0.25, 0.29, 0.35),
      });
      cursorY -= META_SIZE + 3;
    }
    cursorY -= 8;
  };

  const drawRule = (atY: number, thickness = 0.5): void => {
    (page ?? addPage()).drawLine({
      start: { x: MARGIN, y: atY },
      end: { x: PAGE_WIDTH - MARGIN, y: atY },
      thickness,
      color: rgb(0.72, 0.76, 0.82),
    });
  };

  const drawTableHeading = (table: ValidatedPdfTable, continued = false): void => {
    const current = page ?? addPage();
    const label = pdfText(table.label) || pdfText(table.key) || 'Table';
    const heading = continued ? `${label} (continued)` : label;
    current.drawText(heading, {
      x: MARGIN,
      y: cursorY - SECTION_SIZE,
      size: SECTION_SIZE,
      font: boldFont,
      color: rgb(0.10, 0.18, 0.30),
    });
    cursorY -= SECTION_SIZE + 5;
  };

  const columnWidths = (columnCount: number): number[] => {
    const available = PAGE_WIDTH - MARGIN * 2;
    const width = available / columnCount;
    return Array.from({ length: columnCount }, () => width);
  };

  const drawColumnHeader = (
    table: ValidatedPdfTable,
    widths: number[],
  ): void => {
    const current = page ?? addPage();
    let x = MARGIN;
    for (const [index, column] of table.columns.entries()) {
      const label = wrapText(pdfText(column.label), boldFont, HEADER_SIZE, widths[index]! - CELL_PADDING * 2, 2);
      current.drawText(label[0] ?? '', {
        x: x + CELL_PADDING,
        y: cursorY - HEADER_SIZE,
        size: HEADER_SIZE,
        font: boldFont,
        color: rgb(0.12, 0.16, 0.22),
      });
      x += widths[index]!;
    }
    cursorY -= HEADER_SIZE + 7;
    drawRule(cursorY, 0.8);
    cursorY -= 5;
  };

  const drawTableRow = (
    table: ValidatedPdfTable,
    row: ReportingExportRow,
    widths: number[],
  ): number => {
    const current = page ?? addPage();
    const wrapped = table.columns.map((column, index) =>
      wrapText(
        pdfText(cellText(row[column.key])),
        regularFont,
        CELL_SIZE,
        widths[index]! - CELL_PADDING * 2,
        MAX_CELL_LINES,
      ),
    );
    const lineCount = Math.max(...wrapped.map((lines) => lines.length), 1);
    const rowHeight = lineCount * LINE_HEIGHT + CELL_PADDING * 2;
    let x = MARGIN;
    for (const [index, lines] of wrapped.entries()) {
      for (const [lineIndex, line] of lines.entries()) {
        current.drawText(line, {
          x: x + CELL_PADDING,
          y: cursorY - CELL_SIZE - CELL_PADDING - lineIndex * LINE_HEIGHT,
          size: CELL_SIZE,
          font: regularFont,
          color: rgb(0.18, 0.20, 0.24),
        });
      }
      x += widths[index]!;
    }
    cursorY -= rowHeight;
    drawRule(cursorY, 0.25);
    return rowHeight;
  };

  addPage();
  drawReportHeader();

  for (const table of tables) {
    const widths = columnWidths(table.columns.length);
    const tableHeaderHeight = SECTION_SIZE + HEADER_SIZE + 20;
    if (cursorY - tableHeaderHeight < CONTENT_BOTTOM) {
      addPage();
    }
    drawTableHeading(table);
    drawColumnHeader(table, widths);

    for (const row of table.rows) {
      const rowHeight = estimateRowHeight(table, row, widths, regularFont);
      if (cursorY - rowHeight < CONTENT_BOTTOM) {
        addPage();
        drawTableHeading(table, true);
        drawColumnHeader(table, widths);
      }
      drawTableRow(table, row, widths);
    }
    cursorY -= SECTION_GAP;
  }

  pages.forEach((current, index) => {
    current.drawText(`Page ${index + 1}`, {
      x: PAGE_WIDTH - MARGIN - 42,
      y: MARGIN - 2,
      size: META_SIZE,
      font: regularFont,
      color: rgb(0.35, 0.39, 0.45),
    });
  });

  const bytes = Buffer.from(await document.save());
  return {
    bytes,
    contentType: PDF_CONTENT_TYPE,
    filename,
    fileSize: bytes.length,
    checksum: checksumBytes(bytes),
    checksumAlgorithm: PDF_CHECKSUM_ALGORITHM,
  };
}

function validateSnapshotTables(
  snapshot: PublicReportingExport,
): ValidatedPdfTable[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.tables)) {
    throw new PdfRendererError(
      'INVALID_SNAPSHOT',
      'PDF rendering requires a canonical export snapshot with governed tables.',
    );
  }
  if (snapshot.tables.length === 0) {
    throw new PdfRendererError(
      'NON_TABULAR_DATASET',
      'The supplied dataset has no governed tabular table for PDF rendering.',
    );
  }
  if (snapshot.tables.length > MAX_TABLES) {
    throw new PdfRendererError(
      'PDF_CONTENT_TOO_LARGE',
      `PDF output must not contain more than ${MAX_TABLES} tables.`,
    );
  }

  return snapshot.tables.map((table, index) => {
    try {
      const candidate = table as unknown;
      if (!isRecord(candidate)) {
        throw new PdfRendererError(
          'INVALID_TABLE',
          `Table ${index} must be a governed object.`,
        );
      }
      const columns = validateReportingExportColumns(candidate.columns);
      if (columns.length > MAX_COLUMNS) {
        throw new PdfRendererError(
          'PDF_CONTENT_TOO_LARGE',
          `Table ${index} must not contain more than ${MAX_COLUMNS} columns.`,
        );
      }
      const rows = validateReportingExportRows(candidate.rows, columns);
      return {
        key: typeof candidate.key === 'string' ? candidate.key : `table-${index + 1}`,
        label: typeof candidate.label === 'string' ? candidate.label : '',
        columns,
        rows,
      };
    } catch (error) {
      if (error instanceof PdfRendererError) throw error;
      if (error instanceof CsvRendererError) {
        throw new PdfRendererError(
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

function estimateRowHeight(
  table: ValidatedPdfTable,
  row: ReportingExportRow,
  widths: number[],
  font: PDFFont,
): number {
  const lineCount = Math.max(
    ...table.columns.map((column, index) =>
      wrapText(
        pdfText(cellText(row[column.key])),
        font,
        CELL_SIZE,
        widths[index]! - CELL_PADDING * 2,
        MAX_CELL_LINES,
      ).length,
    ),
    1,
  );
  return lineCount * LINE_HEIGHT + CELL_PADDING * 2;
}

function cellText(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Standard PDF fonts do not cover every Unicode script. Normalize accents
 * where possible and replace unsupported/control code points with a harmless
 * ASCII question mark so non-ASCII input can never break PDF generation.
 */
function pdfText(value: string): string {
  return Array.from(value.normalize('NFKD'))
    .filter((character) => !/\p{Mark}/u.test(character))
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint >= 0x20 && codePoint <= 0x7e) return character;
      if (/\s/u.test(character)) return ' ';
      return '?';
    })
    .join('')
    .replace(/ +/g, ' ')
    .trim();
}

function wrapText(
  value: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const text = neutralizeSpreadsheetFormula(value);
  if (!text) return [''];
  const lines: string[] = [];
  let current = '';
  for (const character of Array.from(text)) {
    const candidate = current + character;
    if (current === '' || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = character;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);

  const consumed = lines.join('').length;
  if (consumed < text.length) {
    const lastIndex = Math.min(lines.length, maxLines) - 1;
    const base = lines[lastIndex] ?? '';
    lines[lastIndex] = fitWithEllipsis(base, font, size, maxWidth);
  }
  return lines.slice(0, maxLines);
}

function fitWithEllipsis(
  value: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string {
  const suffix = '...';
  let result = value;
  while (
    result.length > 0 &&
    font.widthOfTextAtSize(`${result}${suffix}`, size) > maxWidth
  ) {
    result = result.slice(0, -1);
  }
  return `${result}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
