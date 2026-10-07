import { Buffer } from 'node:buffer';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  CLIENT_CONFIGURATION_STATUSES,
  isClientConfigurationStatus,
  type ClientConfigurationFilters,
  type ClientConfigurationStatus,
  type ClientConfigurationValue,
  type CreateClientConfigurationInput,
  type UpdateClientConfigurationInput,
} from './client-configuration.types';

const KEY_PATTERN = /^[A-Z][A-Z0-9_.-]*$/;
const MAX_KEY_LENGTH = 100;
const MAX_VALUE_BYTES = 65_536;
const MAX_VALUE_DEPTH = 20;

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

export function parseClientConfigurationClientIdParam(value: string): string {
  return parseUuid(value, 'clientId');
}

export function parseClientConfigurationIdParam(value: string): string {
  return parseUuid(value, 'clientConfigurationId');
}

export function normalizeClientConfigurationKey(value: string): string {
  return value.trim().toUpperCase();
}

function readKey(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field: 'key', message: 'key is required.' });
    return undefined;
  }
  const key = normalizeClientConfigurationKey(value);
  if (key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) {
    details.push({
      field: 'key',
      message:
        'key must start with a letter, contain only letters, digits, dots, hyphens, or underscores, and be at most 100 characters.',
    });
    return undefined;
  }
  // BE-27J/K/M own these namespaces through typed facades. Generic
  // Client/Building configuration must not bypass their validation rules.
  const reservedPrefix = ['OPERATIONAL.', 'PRESENTATION.', 'BRANDING.'].find((prefix) =>
    key.startsWith(prefix),
  );
  if (reservedPrefix) {
    details.push({
      field: 'key',
      message: `${reservedPrefix}* keys must be managed through their dedicated configuration API.`,
    });
    return undefined;
  }
  return key;
}

function isJsonValue(value: unknown, depth = 0): value is ClientConfigurationValue {
  if (depth > MAX_VALUE_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
  }
  return false;
}

function readValue(value: unknown, details: Detail[]): ClientConfigurationValue | undefined {
  if (!isJsonValue(value)) {
    details.push({
      field: 'value',
      message: 'value must be valid JSON with a maximum nesting depth of 20.',
    });
    return undefined;
  }

  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_VALUE_BYTES) {
    details.push({
      field: 'value',
      message: `value must be at most ${MAX_VALUE_BYTES} bytes when serialized as JSON.`,
    });
    return undefined;
  }
  return value;
}

function readStatus(
  value: unknown,
  details: Detail[],
): ClientConfigurationStatus | undefined {
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

export function parseCreateClientConfigurationBody(
  body: unknown,
): Omit<CreateClientConfigurationInput, 'clientId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: Detail[] = [];
  for (const field of Object.keys(body)) {
    if (!['key', 'value', 'status'].includes(field)) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
  const key = readKey(body.key, details);
  let value: ClientConfigurationValue | undefined;
  if (!hasOwn(body, 'value')) {
    details.push({ field: 'value', message: 'value is required.' });
  } else {
    value = readValue(body.value, details);
  }
  const status = readStatus(body.status, details);

  if (details.length > 0 || !key || value === undefined) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    key,
    value,
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateClientConfigurationBody(
  body: unknown,
): UpdateClientConfigurationInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  if (hasOwn(body, 'clientId') || hasOwn(body, 'key')) {
    const field = hasOwn(body, 'clientId') ? 'clientId' : 'key';
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} is immutable and cannot be updated.` },
    ]);
  }

  const details: Detail[] = [];
  for (const field of Object.keys(body)) {
    if (!['value', 'status'].includes(field)) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
  const value = hasOwn(body, 'value') ? readValue(body.value, details) : undefined;
  const status = readStatus(body.status, details);
  if (!hasOwn(body, 'value') && status === undefined && details.length === 0) {
    details.push({
      field: 'body',
      message: 'At least one of value or status must be supplied.',
    });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(hasOwn(body, 'value') ? { value: value as ClientConfigurationValue } : {}),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseClientConfigurationFilters(
  status: unknown,
): ClientConfigurationFilters {
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
