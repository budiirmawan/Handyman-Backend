export { createReportingExportRouter } from './reporting-export.routes';
export { reportingExportService } from './reporting-export.service';
export {
  getReportingExportDatasetAdapter,
  REPORTING_EXPORT_DATASET_REGISTRY,
} from './reporting-export.registry';
export type {
  ReportingExportAdapterResult,
  ReportingExportDatasetAdapter,
  ReportingExportProjection,
} from './reporting-export.registry';

export type {
  PublicReportingExport,
  ReportingExportColumn,
  ReportingExportColumnType,
  ReportingExportDataset,
  ReportingExportFilters,
  ManagementReportingExportDataset,
  ReportingExportKpiValue,
  ReportingExportMetadata,
  ReportingExportRow,
  ReportingExportTable,
} from './reporting-export.types';

export {
  MANAGEMENT_REPORTING_EXPORT_DATASETS,
  REPORTING_EXPORT_COLUMN_TYPES,
  REPORTING_EXPORT_DATASETS,
  isManagementReportingExportDataset,
  isReportingExportDataset,
} from './reporting-export.types';

export { parseReportingExportQuery } from './reporting-export.validation';

export {
  CSV_CHECKSUM_ALGORITHM,
  CSV_CONTENT_TYPE,
  CSV_LINE_ENDING,
  CsvRendererError,
  checksumBytes,
  neutralizeSpreadsheetFormula,
  renderReportingCsv,
  renderReportingCsvTable,
  safeFilename,
  validateReportingExportColumns,
  validateReportingExportRows,
  validateReportingExportTable,
} from './csv-renderer';
export type {
  CsvRenderResult,
  CsvRendererErrorCode,
  CsvRendererOptions,
  ValidatedReportingExportTable,
} from './csv-renderer';

export {
  XLSX_CHECKSUM_ALGORITHM,
  XLSX_CONTENT_TYPE,
  XlsxRendererError,
  renderReportingXlsx,
} from './xlsx-renderer';
export type {
  XlsxRenderResult,
  XlsxRendererErrorCode,
  XlsxRendererOptions,
} from './xlsx-renderer';

export {
  PDF_CHECKSUM_ALGORITHM,
  PDF_CONTENT_TYPE,
  PdfRendererError,
  renderReportingPdf,
} from './pdf-renderer';
export type {
  PdfRenderResult,
  PdfRendererErrorCode,
  PdfRendererOptions,
} from './pdf-renderer';
