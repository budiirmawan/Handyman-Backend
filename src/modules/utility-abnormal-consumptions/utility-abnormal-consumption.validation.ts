import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isUtilityType, type UtilityType } from '../utility-meters/utility-meter.types';
import {
  UTILITY_ABNORMALITY_COMPARISON_MODES,
  UTILITY_ABNORMALITY_RULE_STATUSES,
  UTILITY_ABNORMALITY_TYPES,
  UTILITY_ABNORMAL_CONSUMPTION_STATUSES,
  isUtilityAbnormalConsumptionStatus,
  isUtilityAbnormalityComparisonMode,
  isUtilityAbnormalityRuleStatus,
  isUtilityAbnormalityType,
  type UtilityAbnormalConsumptionStatus,
  type UtilityAbnormalityComparisonMode,
  type UtilityAbnormalityRuleStatus,
  type UtilityAbnormalityType,
} from './utility-abnormal-consumption.types';

/** BE-18J — Abnormal Consumption request validation. */

const MAX_NOTES_LENGTH = 1024;
const MAX_NAME_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_LIMIT = 500;
const MAX_THRESHOLD = 1_000_000_000;
const MAX_BASELINE_WINDOW = 24;

export type ValidationDetail = {
  field: string;
  message: string;
};

export type EvaluateConsumptionBody = {
  notes?: string | null;
};

export type CreateUtilityAbnormalityRuleBody = {
  utilityType: UtilityType;
  abnormalityType: UtilityAbnormalityType;
  name: string;
  description?: string | null;
  thresholdValue?: number | null;
  comparisonMode?: UtilityAbnormalityComparisonMode;
  baselineWindow?: number;
  status?: UtilityAbnormalityRuleStatus;
};

export type ResolveAbnormalConsumptionBody = {
  status: 'RESOLVED' | 'DISMISSED';
  resolutionNotes?: string | null;
};

export type LinkAbnormalConsumptionFindingBody = {
  findingId?: string;
  title?: string;
  description?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUuidParam(raw: string, field: string, label: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseAbnormalConsumptionIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Abnormal consumption id');
}

export function parseAbnormalityConsumptionIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Consumption id');
}

export function parseAbnormalityMeterIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Meter id');
}

export function parseAbnormalityBuildingIdParam(raw: string): string {
  return parseUuidParam(raw, 'buildingId', 'Building id');
}

export function parseAbnormalityTenantIdParam(raw: string): string {
  return parseUuidParam(raw, 'tenantCompanyId', 'Tenant company id');
}

export function parseAbnormalityClientIdParam(raw: string): string {
  return parseUuidParam(raw, 'clientId', 'Client id');
}

/**
 * Parses an evaluation request.
 *
 * Only optional notes are accepted. The detected value, reference value and
 * abnormality type all come from the consumption and the configured rules —
 * a caller-supplied verdict would defeat the point of detection.
 */
export function parseEvaluateConsumptionBody(
  body: unknown,
): EvaluateConsumptionBody {
  const source = body === undefined || body === null ? {} : body;
  if (!isRecord(source)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const notes = readNullableText(
    source.notes,
    'notes',
    'Notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (source.detectedValue !== undefined) {
    details.push({
      field: 'detectedValue',
      message:
        'The detected value is read from the consumption and must not be supplied.',
    });
  }
  if (source.abnormalityType !== undefined) {
    details.push({
      field: 'abnormalityType',
      message:
        'The abnormality type is determined by the configured rules and must not be supplied.',
    });
  }
  if (source.status !== undefined) {
    details.push({
      field: 'status',
      message:
        'A detected abnormality is always created as OPEN; resolve it explicitly instead.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return { ...(notes === undefined ? {} : { notes }) };
}

/** Parses a detection rule — the lightweight, configurable threshold. */
export function parseCreateUtilityAbnormalityRuleBody(
  body: unknown,
): CreateUtilityAbnormalityRuleBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let utilityType: UtilityType | undefined;
  if (typeof body.utilityType !== 'string' || !isUtilityType(body.utilityType)) {
    details.push({
      field: 'utilityType',
      message: 'Utility type must be one of: ELECTRICITY, WATER, GAS.',
    });
  } else {
    utilityType = body.utilityType;
  }

  let abnormalityType: UtilityAbnormalityType | undefined;
  if (!isUtilityAbnormalityType(body.abnormalityType)) {
    details.push({
      field: 'abnormalityType',
      message: `Abnormality type must be one of: ${UTILITY_ABNORMALITY_TYPES.join(', ')}.`,
    });
  } else {
    abnormalityType = body.abnormalityType;
  }

  const name = readRequiredText(
    body.name,
    'name',
    'Name',
    MAX_NAME_LENGTH,
    details,
  );
  const description = readNullableText(
    body.description,
    'description',
    'Description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );

  let comparisonMode: UtilityAbnormalityComparisonMode | undefined;
  if (body.comparisonMode !== undefined) {
    if (!isUtilityAbnormalityComparisonMode(body.comparisonMode)) {
      details.push({
        field: 'comparisonMode',
        message: `Comparison mode must be one of: ${UTILITY_ABNORMALITY_COMPARISON_MODES.join(', ')}.`,
      });
    } else {
      comparisonMode = body.comparisonMode;
    }
  }

  // A threshold must be a finite, non-negative number when supplied. Whether
  // one is *required* depends on the abnormality type, which the service
  // decides — structural checks like ZERO_USAGE need no number.
  let thresholdValue: number | null | undefined;
  if (body.thresholdValue === null) {
    thresholdValue = null;
  } else if (body.thresholdValue !== undefined) {
    if (
      typeof body.thresholdValue !== 'number' ||
      !Number.isFinite(body.thresholdValue)
    ) {
      details.push({
        field: 'thresholdValue',
        message: 'Threshold value must be a finite number.',
      });
    } else if (body.thresholdValue < 0) {
      details.push({
        field: 'thresholdValue',
        message: 'Threshold value must not be negative.',
      });
    } else if (body.thresholdValue > MAX_THRESHOLD) {
      details.push({
        field: 'thresholdValue',
        message: `Threshold value must be at most ${MAX_THRESHOLD}.`,
      });
    } else {
      thresholdValue = body.thresholdValue;
    }
  }

  let baselineWindow: number | undefined;
  if (body.baselineWindow !== undefined) {
    if (
      !Number.isInteger(body.baselineWindow) ||
      (body.baselineWindow as number) < 1 ||
      (body.baselineWindow as number) > MAX_BASELINE_WINDOW
    ) {
      details.push({
        field: 'baselineWindow',
        message: `Baseline window must be an integer between 1 and ${MAX_BASELINE_WINDOW}.`,
      });
    } else {
      baselineWindow = body.baselineWindow as number;
    }
  }

  let status: UtilityAbnormalityRuleStatus | undefined;
  if (body.status !== undefined) {
    if (!isUtilityAbnormalityRuleStatus(body.status)) {
      details.push({
        field: 'status',
        message: `Status must be one of: ${UTILITY_ABNORMALITY_RULE_STATUSES.join(', ')}.`,
      });
    } else {
      status = body.status;
    }
  }

  if (!utilityType || !abnormalityType || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    utilityType,
    abnormalityType,
    name,
    ...(description === undefined ? {} : { description }),
    ...(thresholdValue === undefined ? {} : { thresholdValue }),
    ...(comparisonMode === undefined ? {} : { comparisonMode }),
    ...(baselineWindow === undefined ? {} : { baselineWindow }),
    ...(status === undefined ? {} : { status }),
  };
}

/** Parses a closure request: RESOLVED or DISMISSED only. */
export function parseResolveAbnormalConsumptionBody(
  body: unknown,
): ResolveAbnormalConsumptionBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let status: 'RESOLVED' | 'DISMISSED' | undefined;
  if (body.status !== 'RESOLVED' && body.status !== 'DISMISSED') {
    details.push({
      field: 'status',
      message: 'Status must be one of: RESOLVED, DISMISSED.',
    });
  } else {
    status = body.status;
  }

  const resolutionNotes = readNullableText(
    body.resolutionNotes,
    'resolutionNotes',
    'Resolution notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!status || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    status,
    ...(resolutionNotes === undefined ? {} : { resolutionNotes }),
  };
}

/**
 * Parses a Finding binding request. Either an existing `findingId`, or a
 * title for BE-09 to create one — never both, since that would be ambiguous.
 */
export function parseLinkAbnormalConsumptionFindingBody(
  body: unknown,
): LinkAbnormalConsumptionFindingBody {
  const source = body === undefined || body === null ? {} : body;
  if (!isRecord(source)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const findingId = readOptionalUuid(
    source.findingId,
    'findingId',
    'Finding id',
    details,
  );
  const title = readNullableText(
    source.title,
    'title',
    'Title',
    MAX_TITLE_LENGTH,
    details,
  );
  const description = readNullableText(
    source.description,
    'description',
    'Description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );

  if (findingId && (title || description)) {
    details.push({
      field: 'findingId',
      message:
        'Supply either an existing finding id or details for a new finding, not both.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(findingId === undefined ? {} : { findingId }),
    ...(title === undefined || title === null ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
}

export function parseAbnormalityDateQuery(
  raw: string | undefined,
  field: string,
): Date | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const date = new Date(raw.trim());
  if (Number.isNaN(date.getTime())) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid ISO-8601 date string.` },
    ]);
  }
  return date;
}

export function parseAbnormalityUuidQuery(
  raw: string | undefined,
  field: string,
  label: string,
): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseAbnormalityStatusQuery(
  raw: string | undefined,
): UtilityAbnormalConsumptionStatus | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityAbnormalConsumptionStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `status must be one of: ${UTILITY_ABNORMAL_CONSUMPTION_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return value;
}

export function parseAbnormalityRuleStatusQuery(
  raw: string | undefined,
): UtilityAbnormalityRuleStatus | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityAbnormalityRuleStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `status must be one of: ${UTILITY_ABNORMALITY_RULE_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return value;
}

export function parseAbnormalityTypeQuery(
  raw: string | undefined,
): UtilityAbnormalityType | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityAbnormalityType(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'abnormalityType',
        message: `abnormalityType must be one of: ${UTILITY_ABNORMALITY_TYPES.join(', ')}.`,
      },
    ]);
  }
  return value;
}

export function parseAbnormalityUtilityTypeQuery(
  raw: string | undefined,
): UtilityType | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityType(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'utilityType',
        message: 'utilityType must be one of: ELECTRICITY, WATER, GAS.',
      },
    ]);
  }
  return value;
}

export function parseAbnormalityLimitQuery(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'limit',
        message: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      },
    ]);
  }
  return value;
}

function readRequiredText(
  value: unknown,
  field: string,
  label: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${label} is required.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${label} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readNullableText(
  value: unknown,
  field: string,
  label: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${label} must be a string or null.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${label} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}
