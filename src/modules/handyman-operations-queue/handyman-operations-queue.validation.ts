import { AppError } from '../../shared/errors';
import {
  parseHandymanServiceRequestListQuery,
} from '../handyman-api/handyman-api.validation';
import type { HandymanServiceRequestListFilters } from '../handyman-requests';

export type HandymanOperationsQueueQuery = {
  filters: HandymanServiceRequestListFilters;
  limit: number;
  offset: number;
};

function readPageNumber(
  value: unknown,
  field: 'limit' | 'offset',
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw AppError.validation('Request query validation failed.', [
      {
        field,
        message: `${field} must be an integer between ${minimum} and ${maximum}.`,
      },
    ]);
  }
  return parsed;
}

/**
 * Reuses the established Client-scoped Handyman request filters and adds only
 * bounded pagination. The existing request parser remains the authority for
 * Client, tenant, Building, space, attribution and lifecycle-status inputs.
 */
export function parseHandymanOperationsQueueQuery(
  query: unknown,
): HandymanOperationsQueueQuery {
  const filters = parseHandymanServiceRequestListQuery(query);
  const source = typeof query === 'object' && query !== null && !Array.isArray(query)
    ? query as Record<string, unknown>
    : {};
  return {
    filters,
    limit: readPageNumber(source.limit, 'limit', 20, 1, 50),
    offset: readPageNumber(source.offset, 'offset', 0, 0, 10000),
  };
}
