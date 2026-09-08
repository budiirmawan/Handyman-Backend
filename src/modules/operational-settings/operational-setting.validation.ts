import { AppError } from '../../shared/errors';
import { isValidTimeZone } from '../buildings';
import {
  CLIENT_CONFIGURATION_STATUSES,
  isClientConfigurationStatus,
} from '../client-configurations';
import { isValidUuid } from '../clients';
import { operationalSettingKeyNotAllowedError } from './operational-setting.errors';
import {
  OPERATIONAL_SETTING_DEFINITIONS,
  type CreateOperationalSettingInput,
  type OperationalSettingFilters,
  type OperationalSettingKey,
  type OperationalSettingStatus,
  type OperationalSettingValue,
  type UpdateOperationalSettingInput,
} from './operational-setting.types';

type Detail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parseUuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return normalized;
}

export const parseOperationalSettingClientId = (value: string): string =>
  parseUuid(value, 'clientId');
export const parseOperationalSettingBuildingId = (value: string): string =>
  parseUuid(value, 'buildingId');
export const parseOperationalSettingId = (value: string): string =>
  parseUuid(value, 'operationalSettingId');

export function parseOperationalSettingKey(value: unknown): OperationalSettingKey {
  if (typeof value !== 'string' || value.trim() === '') {
    throw AppError.validation('Request validation failed.', [
      { field: 'key', message: 'key is required.' },
    ]);
  }
  const key = value.trim().toUpperCase();
  const definition = OPERATIONAL_SETTING_DEFINITIONS.find(
    (candidate) => candidate.key === key,
  );
  if (!definition) throw operationalSettingKeyNotAllowedError(key);
  return definition.key;
}

function readStatus(
  value: unknown,
  details: Detail[],
): OperationalSettingStatus | undefined {
  if (value === undefined) return undefined;
  if (!isClientConfigurationStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${CLIENT_CONFIGURATION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readJsonValue(
  value: unknown,
  field: string,
  details: Detail[],
  depth = 0,
): OperationalSettingValue | undefined {
  if (depth > 20) {
    details.push({ field, message: `${field} exceeds the maximum JSON depth.` });
    return undefined;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const parsed: OperationalSettingValue[] = [];
    for (const entry of value) {
      const result = readJsonValue(entry, field, details, depth + 1);
      if (result === undefined) return undefined;
      parsed.push(result);
    }
    return parsed;
  }
  if (isRecord(value)) {
    const parsed: Record<string, OperationalSettingValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = readJsonValue(entry, field, details, depth + 1);
      if (result === undefined) return undefined;
      parsed[key] = result;
    }
    return parsed;
  }
  details.push({ field, message: `${field} must be a valid JSON value.` });
  return undefined;
}

export function validateOperationalSettingValue(
  key: OperationalSettingKey,
  value: OperationalSettingValue,
): OperationalSettingValue {
  if (key === 'SCHEDULE.DEFAULT_TIMEZONE') {
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      value.length > 100 ||
      !isValidTimeZone(value.trim())
    ) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'value',
          message: 'value must be a valid IANA timezone (e.g. Asia/Jakarta).',
        },
      ]);
    }
    return value.trim();
  }
  throw operationalSettingKeyNotAllowedError(key);
}

export function parseCreateOperationalSettingBody(
  body: unknown,
): CreateOperationalSettingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: Detail[] = [];
  for (const field of Object.keys(body)) {
    if (!['key', 'value', 'enabled', 'status'].includes(field)) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
  const key = parseOperationalSettingKey(body.key);
  if (!hasOwn(body, 'value')) {
    details.push({ field: 'value', message: 'value is required.' });
  }
  const rawValue = hasOwn(body, 'value')
    ? readJsonValue(body.value, 'value', details)
    : undefined;
  const enabled = body.enabled ?? true;
  if (typeof enabled !== 'boolean') {
    details.push({ field: 'enabled', message: 'enabled must be boolean.' });
  }
  const status = readStatus(body.status, details) ?? 'ACTIVE';
  if (details.length > 0 || rawValue === undefined) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    key,
    value: validateOperationalSettingValue(key, rawValue),
    enabled: enabled as boolean,
    status,
  };
}

export function parseUpdateOperationalSettingBody(
  body: unknown,
): UpdateOperationalSettingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: Detail[] = [];
  for (const field of Object.keys(body)) {
    if (!['value', 'enabled', 'status'].includes(field)) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
  const value = hasOwn(body, 'value')
    ? readJsonValue(body.value, 'value', details)
    : undefined;
  const enabled = body.enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    details.push({ field: 'enabled', message: 'enabled must be boolean.' });
  }
  const status = readStatus(body.status, details);
  if (
    !hasOwn(body, 'value') &&
    enabled === undefined &&
    status === undefined &&
    details.length === 0
  ) {
    details.push({ field: 'body', message: 'At least one field is required.' });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    ...(hasOwn(body, 'value') ? { value: value as OperationalSettingValue } : {}),
    ...(enabled === undefined ? {} : { enabled: enabled as boolean }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseOperationalSettingFilters(
  status: unknown,
): OperationalSettingFilters {
  if (status === undefined || status === null || status === '') return {};
  if (typeof status !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'status', message: 'status must be a single string value.' },
    ]);
  }
  const normalized = status.trim().toUpperCase();
  if (!isClientConfigurationStatus(normalized)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `status must be one of: ${CLIENT_CONFIGURATION_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return { status: normalized };
}
