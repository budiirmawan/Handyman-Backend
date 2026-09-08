import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  UTILITY_TYPES,
  UTILITY_TYPE_CONFIGURATION_STATUSES,
  isUtilityType,
  isUtilityTypeConfigurationStatus,
  type AddUtilityTypeUomInput,
  type CreateUtilityTypeConfigurationInput,
  type UpdateUtilityTypeConfigurationInput,
  type UpdateUtilityTypeConfigurationStatusInput,
  type UpdateUtilityTypeUomInput,
  type UtilityType,
  type UtilityTypeConfigurationStatus,
} from './utility-type-configuration.types';

/** BE-18B — utility type configuration request validation. */

const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_DECIMAL_PRECISION = 6;

export type ValidationDetail = {
  field: string;
  message: string;
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

export function parseUtilityTypeConfigurationIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Utility type configuration id');
}

export function parseUtilityTypeConfigurationClientIdParam(raw: string): string {
  return parseUuidParam(raw, 'clientId', 'Client id');
}

export function parseUtilityTypeUomIdParam(raw: string): string {
  return parseUuidParam(raw, 'uomId', 'UOM id');
}

export function parseCreateUtilityTypeConfigurationBody(
  body: unknown,
): Omit<CreateUtilityTypeConfigurationInput, 'clientId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const utilityType = readUtilityType(body.utilityType, details);
  const name = readName(body.name, details);
  const description = readNullableDescription(body.description, details);
  const decimalPrecision = readNullableDecimalPrecision(
    body.decimalPrecision,
    details,
  );
  const status = readOptionalStatus(body.status, details);
  const uomIds = readOptionalUomIds(body.uomIds, details);
  const defaultUomId = readNullableUuid(
    body.defaultUomId,
    'defaultUomId',
    'Default UOM id',
    details,
  );

  if (defaultUomId && uomIds && !uomIds.includes(defaultUomId)) {
    details.push({
      field: 'defaultUomId',
      message: 'Default UOM id must be one of the supplied uomIds.',
    });
  }
  if (defaultUomId && !uomIds) {
    details.push({
      field: 'defaultUomId',
      message: 'Default UOM id requires uomIds to be supplied.',
    });
  }

  if (!utilityType || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    utilityType,
    name,
    ...(description === undefined ? {} : { description }),
    ...(decimalPrecision === undefined ? {} : { decimalPrecision }),
    ...(status === undefined ? {} : { status }),
    ...(uomIds === undefined ? {} : { uomIds }),
    ...(defaultUomId === undefined ? {} : { defaultUomId }),
  };
}

export function parseUpdateUtilityTypeConfigurationBody(
  body: unknown,
): UpdateUtilityTypeConfigurationInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name = body.name === undefined ? undefined : readName(body.name, details);
  const description =
    body.description === undefined
      ? undefined
      : readNullableDescription(body.description, details);
  const decimalPrecision =
    body.decimalPrecision === undefined
      ? undefined
      : readNullableDecimalPrecision(body.decimalPrecision, details);
  const status =
    body.status === undefined ? undefined : readOptionalStatus(body.status, details);

  if (body.utilityType !== undefined) {
    details.push({
      field: 'utilityType',
      message:
        'Utility type is immutable; create a separate configuration for another utility type.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(decimalPrecision === undefined ? {} : { decimalPrecision }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateUtilityTypeConfigurationStatusBody(
  body: unknown,
): UpdateUtilityTypeConfigurationStatusInput {
  if (!isRecord(body) || !isUtilityTypeConfigurationStatus(body.status)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${UTILITY_TYPE_CONFIGURATION_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return { status: body.status };
}

export function parseAddUtilityTypeUomBody(body: unknown): AddUtilityTypeUomInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const uomId = readRequiredUuid(body.uomId, 'uomId', 'UOM id', details);
  const isDefault = readOptionalBoolean(body.isDefault, 'isDefault', details);

  if (!uomId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    uomId,
    ...(isDefault === undefined ? {} : { isDefault }),
  };
}

export function parseUpdateUtilityTypeUomBody(
  body: unknown,
): UpdateUtilityTypeUomInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const isDefault = readOptionalBoolean(body.isDefault, 'isDefault', details);
  const status =
    body.status === undefined ? undefined : readOptionalStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  if (isDefault === undefined && status === undefined) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'body',
        message: 'At least one of isDefault or status must be supplied.',
      },
    ]);
  }

  return {
    ...(isDefault === undefined ? {} : { isDefault }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUtilityTypeQuery(
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
        message: `Utility type must be one of: ${UTILITY_TYPES.join(', ')}.`,
      },
    ]);
  }
  return value;
}

export function parseUtilityTypeConfigurationStatusQuery(
  raw: string | undefined,
): UtilityTypeConfigurationStatus | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityTypeConfigurationStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${UTILITY_TYPE_CONFIGURATION_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return value;
}

function readUtilityType(
  value: unknown,
  details: ValidationDetail[],
): UtilityType | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'utilityType', message: 'Utility type is required.' });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!isUtilityType(normalized)) {
    details.push({
      field: 'utilityType',
      message: `Utility type must be one of: ${UTILITY_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Configuration name is required.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Configuration name is required.' });
    return undefined;
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Configuration name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readNullableDescription(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    details.push({
      field: 'description',
      message: 'Description must be a string or null.',
    });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    details.push({
      field: 'description',
      message: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readNullableDecimalPrecision(
  value: unknown,
  details: ValidationDetail[],
): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_DECIMAL_PRECISION
  ) {
    details.push({
      field: 'decimalPrecision',
      message: `Decimal precision must be an integer between 0 and ${MAX_DECIMAL_PRECISION}, or null.`,
    });
    return undefined;
  }
  return value;
}

function readOptionalStatus(
  value: unknown,
  details: ValidationDetail[],
): UtilityTypeConfigurationStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isUtilityTypeConfigurationStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${UTILITY_TYPE_CONFIGURATION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readOptionalBoolean(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    details.push({ field, message: `${field} must be a boolean.` });
    return undefined;
  }
  return value;
}

function readRequiredUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${label} is required.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (!isValidUuid(trimmed)) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return trimmed.toLowerCase();
}

function readNullableUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${label} must be a valid UUID or null.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (!isValidUuid(trimmed)) {
    details.push({ field, message: `${label} must be a valid UUID or null.` });
    return undefined;
  }
  return trimmed.toLowerCase();
}

function readOptionalUomIds(
  value: unknown,
  details: ValidationDetail[],
): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    details.push({ field: 'uomIds', message: 'uomIds must be an array of UUIDs.' });
    return undefined;
  }

  const parsed: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !isValidUuid(entry.trim())) {
      details.push({
        field: 'uomIds',
        message: 'uomIds must contain only valid UUIDs.',
      });
      return undefined;
    }
    const normalized = entry.trim().toLowerCase();
    if (!parsed.includes(normalized)) {
      parsed.push(normalized);
    }
  }
  return parsed;
}
