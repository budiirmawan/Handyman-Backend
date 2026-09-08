import { getReportingExportDatasetAdapter } from './reporting-export.registry';
import type {
  PublicReportingExport,
  ReportingExportFilters,
} from './reporting-export.types';

/**
 * CR-BE-EXP-01 PART 05 — one governed dataset dispatcher.
 *
 * The selected registry adapter delegates validation/calculation to the
 * existing owning KPI/read-model service and returns one canonical snapshot.
 * Format renderers consume that snapshot later; this service never renders or
 * persists an artifact.
 */
export async function getReportingExport(
  filters: ReportingExportFilters,
  userId: string,
): Promise<PublicReportingExport> {
  const adapter = getReportingExportDatasetAdapter(filters.dataset);
  const result = await adapter.load(filters.passThrough, userId);

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

export const reportingExportService = {
  getReportingExport,
};
