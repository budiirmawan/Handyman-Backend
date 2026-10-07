import { AppError } from '../../shared/errors';
import {
  REPORTING_EXPORT_DATASETS,
  isReportingExportDataset,
  type ReportingExportFilters,
} from './reporting-export.types';

/**
 * BE-23J — Export Dataset query validation.
 *
 * Validates only what BE-23J itself owns: which dataset to export.
 * Everything else is handed to the owning BE-23 KPI module's own query
 * parser, so the export can never accept a filter combination the KPI
 * would reject, and BE-23J never re-implements another module's rules.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

/**
 * Query keys BE-23J consumes itself. Everything else is passed through
 * to the owning KPI validator untouched.
 */
const OWN_KEYS = new Set(['dataset']);

export function parseReportingExportQuery(
  query: Record<string, unknown>,
): ReportingExportFilters {
  const details: ValidationDetail[] = [];

  const rawDataset = readSingleParam(query.dataset);
  let dataset: ReportingExportFilters['dataset'] | undefined;
  if (rawDataset === undefined || rawDataset === '') {
    details.push({
      field: 'dataset',
      message: `dataset is required and must be one of: ${REPORTING_EXPORT_DATASETS.join(', ')}.`,
    });
  } else {
    const normalized = rawDataset.trim().toUpperCase();
    if (!isReportingExportDataset(normalized)) {
      details.push({
        field: 'dataset',
        message: `dataset must be one of: ${REPORTING_EXPORT_DATASETS.join(', ')}.`,
      });
    } else {
      dataset = normalized;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  const passThrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!OWN_KEYS.has(key)) {
      passThrough[key] = value;
    }
  }

  const buildingId = readSingleParam(query.buildingId);
  const dateFrom = readSingleParam(query.dateFrom);
  const dateTo = readSingleParam(query.dateTo);

  return {
    dataset: dataset!,
    ...(buildingId ? { buildingId: buildingId.trim() } : {}),
    ...(dateFrom ? { dateFrom: dateFrom.trim() } : {}),
    ...(dateTo ? { dateTo: dateTo.trim() } : {}),
    passThrough,
  };
}

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}
