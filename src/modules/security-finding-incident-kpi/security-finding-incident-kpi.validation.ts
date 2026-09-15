import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { SecurityFindingIncidentKpiFilters } from './security-finding-incident-kpi.types';

/**
 * BE-23F2 — Security Finding / Incident / Handover KPI query validation.
 *
 * Follows the BE-23F1 reporting query conventions (UTC day windows,
 * bounded range, UUID filters) and adds the BE-21A `incidentType`
 * narrowing. Kept local so BE-23F1 and BE-12M validation stay untouched.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** BE-21A incident_type vocabulary. */
export const INCIDENT_KPI_TYPES = [
  'OPERATIONAL',
  'ASSET_FAILURE',
  'FINDING_ESCALATION',
] as const;

export function parseFindingIncidentKpiQuery(
  query: Record<string, unknown>,
): SecurityFindingIncidentKpiFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const securityPostId = readOptionalUuid(
    query.securityPostId,
    'securityPostId',
    details,
  );
  const patrolRouteId = readOptionalUuid(
    query.patrolRouteId,
    'patrolRouteId',
    details,
  );

  let incidentType: string | undefined;
  const rawType = readSingleParam(query.incidentType);
  if (rawType !== undefined && rawType !== '') {
    const normalized = rawType.trim().toUpperCase();
    if (!(INCIDENT_KPI_TYPES as readonly string[]).includes(normalized)) {
      details.push({
        field: 'incidentType',
        message: `incidentType must be one of: ${INCIDENT_KPI_TYPES.join(', ')}.`,
      });
    } else {
      incidentType = normalized;
    }
  }

  const dateFromRaw = readSingleParam(query.dateFrom);
  const dateToRaw = readSingleParam(query.dateTo);
  const dateFrom = dateFromRaw
    ? readOptionalDate(dateFromRaw, 'dateFrom', details)
    : undefined;
  const dateTo = dateToRaw
    ? readOptionalDate(dateToRaw, 'dateTo', details)
    : undefined;

  if (dateFrom && dateTo && dateFrom > dateTo) {
    details.push({
      field: 'dateFrom',
      message: 'dateFrom must not exceed dateTo.',
    });
  }
  if (
    dateFrom &&
    dateTo &&
    (dateTo.getTime() - dateFrom.getTime()) / 86400000 > MAX_RANGE_DAYS
  ) {
    details.push({
      field: 'dateTo',
      message: `Report date range must not exceed ${MAX_RANGE_DAYS} days.`,
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(securityPostId === undefined ? {} : { securityPostId }),
    ...(patrolRouteId === undefined ? {} : { patrolRouteId }),
    ...(incidentType === undefined ? {} : { incidentType }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
  };
}

/**
 * Converts the KPI window into a half-open [start, end) range. A
 * date-only `dateTo` is inclusive of that whole UTC day.
 */
export function findingIncidentKpiRange(
  filters: SecurityFindingIncidentKpiFilters,
): { start: Date | null; end: Date | null } {
  const start = filters.dateFrom ? new Date(filters.dateFrom) : null;
  let end: Date | null = null;
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    end = DATE_ONLY.test(filters.dateTo)
      ? new Date(to.getTime() + 86400000)
      : to;
  }
  return { start, end };
}

function readOptionalDate(
  raw: string,
  field: string,
  details: ValidationDetail[],
): Date | undefined {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({
      field,
      message: `${field} must be a valid ISO-8601 date or datetime.`,
    });
    return undefined;
  }
  return parsed;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!isValidUuid(raw.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return raw.trim().toLowerCase();
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
