import { AppError } from '../../shared/errors';
import { getReportingExportDatasetAdapter } from './reporting-export.registry';
import type {
  PublicReportingExport,
  ReportingExportFilters,
} from './reporting-export.types';

/**
 * R13 FIX 02 — the ONE governed export ceiling, frozen by R13 PART 00D.
 *
 * This is a fixed backend authority: it is deliberately NOT an environment
 * variable, database configuration, adapter metadata, renderer setting or
 * request input, and it is never overridden per dataset or per format.
 *
 * The dimension is scalar CELLS rather than rows alone so that one rule binds
 * tall reports and wide reports alike, and can be evaluated straight off the
 * canonical snapshot without serializing anything.
 */
export const MAX_REPORT_EXPORT_CELLS = 250_000;

/**
 * CR-BE-EXP-01 PART 05 — one governed dataset dispatcher.
 *
 * The selected registry adapter delegates validation/calculation to the
 * existing owning KPI/read-model service and returns one canonical snapshot.
 * Format renderers consume that snapshot later; this service never renders or
 * persists an artifact.
 *
 * R13 FIX 02 — this funnel is also the single shared export ceiling, which is
 * why the assertion lives here rather than in any adapter or renderer: both
 * delivery surfaces pass through it (the live JSON route calls it directly,
 * and archive generation calls it BEFORE `renderReportArchiveArtifact` and
 * before the storage boundary). One bound therefore protects JSON, CSV, XLSX
 * and PDF alike, and a rejected export can never reach a renderer or storage.
 *
 * The ceiling is HARD and fail-closed: no truncation, no row slicing, no
 * automatic pagination, no silent row dropping, no automatic date narrowing.
 */
export async function getReportingExport(
  filters: ReportingExportFilters,
  userId: string,
): Promise<PublicReportingExport> {
  const adapter = getReportingExportDatasetAdapter(filters.dataset);
  const result = await adapter.load(filters.passThrough, userId);

  assertReportingExportWithinCeiling(result.projected.tables);

  return {
    metadata: {
      dataset: adapter.dataset,
      datasetLabel: adapter.datasetLabel,
      buildingId: result.common.buildingId,
      buildingScope: result.common.buildingScope,
      period: {
        dateFrom: result.common.dateFrom,
        dateTo: result.common.dateTo,
      },
      filters: result.appliedFilters,
      asOf: result.common.asOf,
    },
    kpis: result.projected.kpis,
    tables: result.projected.tables,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * FROZEN COUNTING RULE — total scalar cells across every returned table:
 *
 *   tableCells = table.rows.length * table.columns.length
 *   totalCells = sum(tableCells)
 *
 * `rowCount` metadata is deliberately NOT used as the authority, so the bound
 * can never disagree with the rows actually present. Empty tables contribute
 * zero, zero tables total zero, and metadata, KPI values and column headers are
 * not counted. The governed boundary is inclusive: exactly
 * MAX_REPORT_EXPORT_CELLS is allowed and one cell more is rejected.
 *
 * Arithmetic is guarded: array lengths cannot realistically overflow, but a
 * malformed adapter result could, and the frozen rule is to fail closed rather
 * than clamp. A non-integer product (for example a non-array `rows`/`columns`
 * reaching this point as NaN) is therefore refused.
 */
function countReportingExportCells(tables: unknown): number {
  if (!Array.isArray(tables)) {
    throw AppError.internal('Reporting export snapshot is not enumerable.');
  }

  let totalCells = 0;
  for (const table of tables) {
    const rows = (table as { rows?: unknown } | null)?.rows;
    const columns = (table as { columns?: unknown } | null)?.columns;
    if (!Array.isArray(rows) || !Array.isArray(columns)) {
      throw AppError.internal('Reporting export snapshot shape is invalid.');
    }

    const tableCells = rows.length * columns.length;
    if (!Number.isSafeInteger(tableCells)) {
      throw AppError.internal('Reporting export size could not be determined.');
    }

    totalCells += tableCells;
    if (!Number.isSafeInteger(totalCells)) {
      throw AppError.internal('Reporting export size could not be determined.');
    }
  }

  return totalCells;
}

/**
 * The shared fail-closed bound. Over-ceiling exports are refused with the
 * repository's existing validation convention (HTTP 400 / VALIDATION_ERROR),
 * mirroring the established 366-day range precedent, and the client-safe
 * message states the governed limit and the remedy. No memory estimate, SQL,
 * storage reference or renderer internal is exposed.
 *
 * A snapshot that cannot be measured is refused as an internal error rather
 * than reported as a caller validation problem, and equally without leaking
 * internals.
 */
function assertReportingExportWithinCeiling(tables: unknown): void {
  const totalCells = countReportingExportCells(tables);
  if (totalCells > MAX_REPORT_EXPORT_CELLS) {
    throw AppError.validation(
      `The requested report exceeds the maximum export size of ${MAX_REPORT_EXPORT_CELLS} cells. Narrow the filters and/or date range and try again.`,
      [
        {
          field: 'filters',
          message: `Report export must not exceed ${MAX_REPORT_EXPORT_CELLS} cells.`,
        },
      ],
    );
  }
}

export const reportingExportService = {
  getReportingExport,
};
