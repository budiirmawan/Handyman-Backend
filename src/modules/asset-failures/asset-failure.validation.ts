import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  INCIDENT_LOCATION_TYPES,
  INCIDENT_PRIORITIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  isIncidentLocationType,
  isIncidentPriority,
  isIncidentSeverity,
  isIncidentStatus,
  type IncidentLocationType,
  type IncidentPriority,
  type IncidentSeverity,
  type IncidentStatus,
} from '../incidents';
import {
  ASSET_FAILURE_CATEGORIES,
  ASSET_FAILURE_IMPACTS,
  ASSET_FAILURE_STATUSES,
  isAssetFailureCategory,
  isAssetFailureImpact,
  isAssetFailureStatus,
  type AssetFailureCategory,
  type AssetFailureFilters,
  type AssetFailureImpact,
  type AssetFailureStatus,
  type CreateAssetFailureInput,
  type UpdateAssetFailureInput,
} from './asset-failure.types';

export type ValidationDetail = { field: string; message: string };

const INCIDENT_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_\-/]{0,63}$/;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_NOTES_LENGTH = 4000;
const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export function parseAssetFailureIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'incidentId', message: 'incidentId must be a valid UUID.' }]);
  }
  return value;
}

/**
 * `incidentType` is refused rather than ignored: BE-21C always pins it to
 * ASSET_FAILURE, and silently dropping a caller's OPERATIONAL would hide that
 * their intent was not honoured.
 */
export function parseCreateAssetFailureBody(
  body: unknown,
): CreateAssetFailureInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const controlled = [
    'clientId',
    'incidentType',
    'status',
    'incidentStatus',
    'failureStatus',
    'cancelledAt',
    'cancelledByUserId',
    'createdAt',
    'updatedAt',
  ].find((field) => body[field] !== undefined);
  if (controlled) {
    fail([
      {
        field: controlled,
        message:
          controlled === 'incidentType'
            ? 'incidentType is fixed to ASSET_FAILURE by this endpoint.'
            : 'This Incident field is derived by the backend.',
      },
    ]);
  }

  // Asset master data belongs to BE-05: this endpoint binds an Asset, it never
  // creates or edits one. Accepting these would imply otherwise.
  const assetMasterData = [
    'assetCode',
    'assetName',
    'manufacturer',
    'model',
    'serialNumber',
    'assetStatus',
    'assetCategoryId',
    'assetTypeId',
  ].find((field) => body[field] !== undefined);
  if (assetMasterData) {
    fail([
      {
        field: assetMasterData,
        message:
          'Asset master data is owned by the Asset registry; supply assetId only.',
      },
    ]);
  }

  const details: ValidationDetail[] = [];
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const incidentNumber = readIncidentNumber(body.incidentNumber, details);
  const title = readText(body.title, 'title', MAX_TITLE_LENGTH, true, details);
  const description = readNullableText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const severity = readSeverity(body.severity, details);
  const priority = readPriority(body.priority, details);
  const locationType = readLocationType(body.locationType, details);
  const locationId = readId(body.locationId, 'locationId', false, details);
  const assetId = readId(body.assetId, 'assetId', true, details);
  const failureCategory = readCategory(body.failureCategory, true, details);
  const occurredAt = readTimestamp(body.occurredAt, 'occurredAt', true, details);
  const operationalImpact = readImpact(body.operationalImpact, details);
  const notes = readNullableText(body.notes, 'notes', MAX_NOTES_LENGTH, details);
  const reportedByUserId = readId(
    body.reportedByUserId,
    'reportedByUserId',
    false,
    details,
  );

  if (locationType && !locationId) {
    details.push({
      field: 'locationId',
      message: 'locationId is required when locationType is provided.',
    });
  }
  if (locationId && !locationType) {
    details.push({
      field: 'locationType',
      message: 'locationType is required when locationId is provided.',
    });
  }

  if (
    !buildingId ||
    !incidentNumber ||
    !title ||
    !assetId ||
    !failureCategory ||
    !occurredAt ||
    details.length > 0
  ) {
    fail(details);
  }

  return {
    buildingId,
    incidentNumber,
    title,
    ...(description !== undefined ? { description } : {}),
    ...(severity ? { severity } : {}),
    ...(priority ? { priority } : {}),
    ...(locationType ? { locationType } : {}),
    ...(locationId ? { locationId } : {}),
    assetId,
    failureCategory,
    occurredAt,
    ...(operationalImpact !== undefined ? { operationalImpact } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(reportedByUserId ? { reportedByUserId } : {}),
  };
}

export function parseUpdateAssetFailureBody(
  body: unknown,
): UpdateAssetFailureInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const immutable = [
    'clientId',
    'buildingId',
    'incidentNumber',
    'incidentType',
    'status',
    'incidentStatus',
    'locationType',
    'locationId',
    'floorId',
    'areaId',
    'roomId',
    'spaceId',
    'functionalLocationId',
    'reportedByUserId',
    'reportedAt',
    'cancelledAt',
    'cancelledByUserId',
    'createdAt',
    'updatedAt',
    // Re-pointing a recorded failure at another Asset would rewrite history.
    'assetId',
  ].find((field) => body[field] !== undefined);
  if (immutable) {
    fail([
      {
        field: immutable,
        message:
          immutable === 'assetId'
            ? 'The Asset binding is immutable; cancel and re-report instead.'
            : 'This Incident context field is immutable.',
      },
    ]);
  }

  const details: ValidationDetail[] = [];
  const title = body.title === undefined
    ? undefined
    : readText(body.title, 'title', MAX_TITLE_LENGTH, true, details);
  const description = readNullableText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const severity = readSeverity(body.severity, details);
  const priority = readPriority(body.priority, details);
  const failureCategory = readCategory(body.failureCategory, false, details);
  const occurredAt = readTimestamp(body.occurredAt, 'occurredAt', false, details);
  const operationalImpact = readImpact(body.operationalImpact, details);
  const notes = readNullableText(body.notes, 'notes', MAX_NOTES_LENGTH, details);
  const failureStatus = readFailureStatus(body.failureStatus, details);

  const parsed: UpdateAssetFailureInput = {
    ...(title ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(severity ? { severity } : {}),
    ...(priority ? { priority } : {}),
    ...(failureCategory ? { failureCategory } : {}),
    ...(occurredAt ? { occurredAt } : {}),
    ...(operationalImpact !== undefined ? { operationalImpact } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(failureStatus ? { failureStatus } : {}),
  };
  if (Object.keys(parsed).length === 0 && details.length === 0) {
    details.push({
      field: 'body',
      message: 'At least one Asset Failure field is required.',
    });
  }
  if (details.length > 0) fail(details);
  return parsed;
}

export function parseAssetFailureFilters(query: unknown): AssetFailureFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const assetId = readId(query.assetId, 'assetId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const locationType = readLocationType(query.locationType, details);
  const locationId = readId(query.locationId, 'locationId', false, details);
  const failureCategory = readCategory(query.failureCategory, false, details);
  const operationalImpact = readImpact(query.operationalImpact, details);
  const severity = readSeverity(query.severity, details);
  const priority = readPriority(query.priority, details);
  const failureStatus = readFailureStatus(query.failureStatus, details);
  const incidentStatus = readIncidentStatus(query.incidentStatus, details);
  const occurredFrom = readTimestamp(
    query.occurredFrom,
    'occurredFrom',
    false,
    details,
  );
  const occurredTo = readTimestamp(query.occurredTo, 'occurredTo', false, details);
  if (
    occurredFrom &&
    occurredTo &&
    occurredFrom.getTime() > occurredTo.getTime()
  ) {
    details.push({
      field: 'occurredFrom',
      message: 'occurredFrom must be earlier than or equal to occurredTo.',
    });
  }
  if (details.length > 0) fail(details);

  return {
    ...(assetId ? { assetId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(locationType ? { locationType } : {}),
    ...(locationId ? { locationId } : {}),
    ...(failureCategory ? { failureCategory } : {}),
    ...(operationalImpact ? { operationalImpact } : {}),
    ...(severity ? { severity } : {}),
    ...(priority ? { priority } : {}),
    ...(failureStatus ? { failureStatus } : {}),
    ...(incidentStatus ? { incidentStatus } : {}),
    ...(occurredFrom ? { occurredFrom } : {}),
    ...(occurredTo ? { occurredTo } : {}),
  };
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

function readIncidentNumber(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'incidentNumber',
      message: 'incidentNumber is required.',
    });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!INCIDENT_NUMBER_PATTERN.test(normalized)) {
    details.push({
      field: 'incidentNumber',
      message: 'incidentNumber has an invalid format.',
    });
    return undefined;
  }
  return normalized;
}

function readCategory(
  value: unknown,
  required: boolean,
  details: ValidationDetail[],
): AssetFailureCategory | undefined {
  if (value === undefined && !required) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isAssetFailureCategory(normalized)) {
    details.push({
      field: 'failureCategory',
      message: `failureCategory must be one of: ${ASSET_FAILURE_CATEGORIES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

/**
 * Operational impact is "where applicable": explicit null clears it, and an
 * absent value leaves it untouched. `NONE` is a real answer, distinct from
 * both.
 */
function readImpact(
  value: unknown,
  details: ValidationDetail[],
): AssetFailureImpact | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isAssetFailureImpact(normalized)) {
    details.push({
      field: 'operationalImpact',
      message: `operationalImpact must be one of: ${ASSET_FAILURE_IMPACTS.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readFailureStatus(
  value: unknown,
  details: ValidationDetail[],
): AssetFailureStatus | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isAssetFailureStatus(normalized)) {
    details.push({
      field: 'failureStatus',
      message: `failureStatus must be one of: ${ASSET_FAILURE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readIncidentStatus(
  value: unknown,
  details: ValidationDetail[],
): IncidentStatus | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isIncidentStatus(normalized)) {
    details.push({
      field: 'incidentStatus',
      message: `incidentStatus must be one of: ${INCIDENT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readSeverity(
  value: unknown,
  details: ValidationDetail[],
): IncidentSeverity | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isIncidentSeverity(normalized)) {
    details.push({
      field: 'severity',
      message: `severity must be one of: ${INCIDENT_SEVERITIES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readPriority(
  value: unknown,
  details: ValidationDetail[],
): IncidentPriority | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isIncidentPriority(normalized)) {
    details.push({
      field: 'priority',
      message: `priority must be one of: ${INCIDENT_PRIORITIES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readLocationType(
  value: unknown,
  details: ValidationDetail[],
): IncidentLocationType | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isIncidentLocationType(normalized)) {
    details.push({
      field: 'locationType',
      message: `locationType must be one of: ${INCIDENT_LOCATION_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readText(
  value: unknown,
  field: string,
  maxLength: number,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({
      field,
      message: `${field}${required ? ' is required' : ' must be a string'}.`,
    });
    return undefined;
  }
  const result = value.trim();
  if (result.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return result;
}

function readNullableText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readText(value, field, maxLength, false, details);
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
      message: `${field}${required ? ' is required and' : ''} must be an ISO-8601 date-time with a timezone.`,
    });
    return undefined;
  }
  const result = new Date(value.trim());
  if (Number.isNaN(result.getTime())) {
    details.push({ field, message: `${field} must be valid.` });
    return undefined;
  }
  return result;
}
