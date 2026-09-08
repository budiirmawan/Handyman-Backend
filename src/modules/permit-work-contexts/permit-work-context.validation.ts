import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isValidWorkType,
  normalizeWorkType,
} from '../work-orders/work-order.validation';
import {
  PERMIT_WORK_LOCATION_TYPES,
  isPermitWorkLocationType,
  type AssignPermitWorkLocationInput,
  type AssignPermitWorkTypeInput,
  type PermitWorkContextFilters,
  type PermitWorkLocationType,
  type UpdatePermitWorkContextInput,
} from './permit-work-context.types';

type ValidationDetail = { field: string; message: string };
const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export const parsePermitWorkApplicationIdParam = (raw: string): string =>
  parseId(raw, 'permitApplicationId');
export const parsePermitWorkPermitIdParam = (raw: string): string =>
  parseId(raw, 'permitId');

export function parseAssignPermitWorkLocationBody(
  body: unknown,
): AssignPermitWorkLocationInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];
  const locationType = readLocationType(body.locationType, true, details);
  const locationId = readId(body.locationId, 'locationId', true, details);
  const plannedStartAt = readTimestamp(
    body.plannedStartAt,
    'plannedStartAt',
    true,
    details,
  );
  const plannedEndAt = readTimestamp(
    body.plannedEndAt,
    'plannedEndAt',
    true,
    details,
  );
  const accessRestrictionNotes = readNullableText(
    body.accessRestrictionNotes,
    'accessRestrictionNotes',
    2000,
    details,
  );
  const workDescription = readNullableText(
    body.workDescription,
    'workDescription',
    4000,
    details,
  );
  if (
    !locationType ||
    !locationId ||
    !plannedStartAt ||
    !plannedEndAt ||
    details.length > 0
  ) {
    fail(details);
  }
  return {
    locationType,
    locationId,
    plannedStartAt,
    plannedEndAt,
    ...(accessRestrictionNotes !== undefined ? { accessRestrictionNotes } : {}),
    ...(workDescription !== undefined ? { workDescription } : {}),
  };
}

export function parseAssignPermitWorkTypeBody(
  body: unknown,
): AssignPermitWorkTypeInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];
  const workType = readWorkType(body.workType, true, details);
  const workDescription = readNullableText(
    body.workDescription,
    'workDescription',
    4000,
    details,
  );
  if (!workType || details.length > 0) fail(details);
  return {
    workType,
    ...(workDescription !== undefined ? { workDescription } : {}),
  };
}

export function parseUpdatePermitWorkContextBody(
  body: unknown,
): UpdatePermitWorkContextInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const immutable = [
    'permitId',
    'permitApplicationId',
    'permitReference',
    'clientId',
    'buildingId',
    'applicationStatus',
    'createdByUserId',
    'updatedByUserId',
    'createdAt',
    'updatedAt',
  ].find((field) => body[field] !== undefined);
  if (immutable) {
    fail([{ field: immutable, message: 'This work-context field is immutable.' }]);
  }

  const details: ValidationDetail[] = [];
  const locationType = readLocationType(body.locationType, false, details);
  const locationId = readId(body.locationId, 'locationId', false, details);
  if ((locationType === undefined) !== (locationId === undefined)) {
    details.push({
      field: 'location',
      message: 'locationType and locationId must be updated together.',
    });
  }
  const workType = readWorkType(body.workType, false, details);
  const workDescription = readNullableText(
    body.workDescription,
    'workDescription',
    4000,
    details,
  );
  const plannedStartAt = readTimestamp(
    body.plannedStartAt,
    'plannedStartAt',
    false,
    details,
  );
  const plannedEndAt = readTimestamp(
    body.plannedEndAt,
    'plannedEndAt',
    false,
    details,
  );
  const accessRestrictionNotes = readNullableText(
    body.accessRestrictionNotes,
    'accessRestrictionNotes',
    2000,
    details,
  );
  const parsed: UpdatePermitWorkContextInput = {
    ...(locationType ? { locationType } : {}),
    ...(locationId ? { locationId } : {}),
    ...(workType ? { workType } : {}),
    ...(workDescription !== undefined ? { workDescription } : {}),
    ...(plannedStartAt ? { plannedStartAt } : {}),
    ...(plannedEndAt ? { plannedEndAt } : {}),
    ...(accessRestrictionNotes !== undefined ? { accessRestrictionNotes } : {}),
  };
  if (Object.keys(parsed).length === 0 && details.length === 0) {
    details.push({
      field: 'body',
      message: 'At least one work-context field is required.',
    });
  }
  if (details.length > 0) fail(details);
  return parsed;
}

export function parsePermitWorkContextFilters(
  query: unknown,
): PermitWorkContextFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const locationType = readLocationType(query.locationType, false, details);
  const locationId = readId(query.locationId, 'locationId', false, details);
  const workType = readWorkType(query.workType, false, details);
  if (details.length > 0) fail(details);
  return {
    ...(buildingId ? { buildingId } : {}),
    ...(locationType ? { locationType } : {}),
    ...(locationId ? { locationId } : {}),
    ...(workType ? { workType } : {}),
  };
}

function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  }
  return value;
}

function readId(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field}${required ? ' is required and' : ''} must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readLocationType(
  value: unknown,
  required: boolean,
  details: ValidationDetail[],
): PermitWorkLocationType | undefined {
  if (value === undefined && !required) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isPermitWorkLocationType(normalized)) {
    details.push({
      field: 'locationType',
      message: `locationType must be one of: ${PERMIT_WORK_LOCATION_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readWorkType(
  value: unknown,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') {
    details.push({ field: 'workType', message: 'workType is required.' });
    return undefined;
  }
  const normalized = normalizeWorkType(value);
  if (!isValidWorkType(normalized)) {
    details.push({
      field: 'workType',
      message: 'workType must be a valid controlled data code.',
    });
    return undefined;
  }
  return normalized;
}

function readTimestamp(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): Date | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !ISO_TIMESTAMP_WITH_ZONE.test(value.trim())) {
    details.push({
      field,
      message: `${field} must be an ISO-8601 date-time with a timezone.`,
    });
    return undefined;
  }
  const normalized = value.trim();
  if (!isCalendarDate(normalized.slice(0, 10))) {
    details.push({ field, message: `${field} contains an invalid calendar date.` });
    return undefined;
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be a valid date and time.` });
    return undefined;
  }
  return parsed;
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function readNullableText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }
  const result = value.trim();
  if (result.length === 0) return null;
  if (result.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return result;
}
