import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  FRONT_DESK_ACTIVITY_TYPES,
  isFrontDeskActivityType,
  type FrontDeskActivityType,
  type FrontDeskLogFilters,
  type FrontDeskLogIdentity,
} from './front-desk-log.types';

export type ValidationDetail = { field: string; message: string };

export function parseFrontDeskLogIdParam(raw: string): FrontDeskLogIdentity {
  const value = raw.trim();
  const separator = value.indexOf(':');
  const activityType = separator < 0 ? '' : value.slice(0, separator);
  const sourceId = separator < 0 ? '' : value.slice(separator + 1);

  const details: ValidationDetail[] = [];
  if (!isFrontDeskActivityType(activityType)) {
    details.push({
      field: 'id',
      message: 'Front Desk Log id has an invalid activity type.',
    });
  }
  if (!isValidUuid(sourceId)) {
    details.push({
      field: 'id',
      message: 'Front Desk Log id has an invalid source id.',
    });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    activityType: activityType as FrontDeskActivityType,
    sourceId: sourceId.toLowerCase(),
  };
}

export function parseFrontDeskLogListQuery(
  query: Record<string, unknown>,
): FrontDeskLogFilters {
  const details: ValidationDetail[] = [];
  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const visitorId = readOptionalUuid(query.visitorId, 'visitorId', details);
  const activityType = readActivityType(
    readSingle(query.activityType),
    details,
  );
  const occurredFrom = readOptionalDate(
    query.occurredFrom,
    'occurredFrom',
    details,
  );
  const occurredTo = readOptionalDate(
    query.occurredTo,
    'occurredTo',
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(visitorId === undefined ? {} : { visitorId }),
    ...(activityType === undefined ? {} : { activityType }),
    ...(occurredFrom === undefined ? {} : { occurredFrom }),
    ...(occurredTo === undefined ? {} : { occurredTo }),
  };
}

function readSingle(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const single = readSingle(value);
  if (single === undefined || single === null || single === '') return undefined;
  if (typeof single !== 'string' || !isValidUuid(single.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return single.trim().toLowerCase();
}

function readOptionalDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const single = readSingle(value);
  if (single === undefined || single === null || single === '') return undefined;
  if (typeof single !== 'string') {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  const parsed = new Date(single);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  return parsed.toISOString();
}

function readActivityType(
  value: unknown,
  details: ValidationDetail[],
): FrontDeskActivityType | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isFrontDeskActivityType(value)) {
    details.push({
      field: 'activityType',
      message: `activityType must be one of: ${FRONT_DESK_ACTIVITY_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}
