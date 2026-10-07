import {
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  failValidation,
  isIncidentStatus,
  isIncidentType,
  isRecord,
  readEnum,
  readUuid,
  type ValidationDetail,
} from '../incidents';
import type { InvestigationReadinessFilters } from './investigation-readiness.types';

export type { ValidationDetail };

/**
 * BE-21F parses query parameters only — there is no request body anywhere in
 * this PART, because nothing can be created or changed.
 */

export function parseIncidentIdParam(raw: string): string {
  const details: ValidationDetail[] = [];
  const value = readUuid(raw, 'incidentId', true, details);
  if (!value || details.length > 0) failValidation(details);
  return value;
}

/**
 * `ready` is a strict `true`/`false` string. Falling back to JS truthiness
 * would quietly read `?ready=false` as "ready", inverting the filter.
 */
function readReadyFlag(
  value: unknown,
  details: ValidationDetail[],
): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  details.push({ field: 'ready', message: 'ready must be true or false.' });
  return undefined;
}

export function parseInvestigationReadinessFilters(
  query: unknown,
): InvestigationReadinessFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];

  const buildingId = readUuid(query.buildingId, 'buildingId', false, details);
  const incidentType = readEnum(
    query.incidentType,
    'incidentType',
    isIncidentType,
    INCIDENT_TYPES,
    false,
    details,
  );
  const status = readEnum(
    query.status,
    'status',
    isIncidentStatus,
    INCIDENT_STATUSES,
    false,
    details,
  );
  const ready = readReadyFlag(query.ready, details);

  if (details.length > 0) failValidation(details);

  return {
    ...(buildingId ? { buildingId } : {}),
    ...(incidentType ? { incidentType } : {}),
    ...(status ? { status } : {}),
    ...(ready !== undefined ? { ready } : {}),
  };
}
