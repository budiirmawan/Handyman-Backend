/**
 * CR-BE-SAAS-01 PART 12B — Configuration HTTP body validation.
 *
 * Routes (§22 frozen):
 *   POST   /api/v1/platform/configuration/:key
 *   PATCH  /api/v1/platform/configuration/:key
 *   GET    /api/v1/platform/configuration
 *   GET    /api/v1/platform/configuration/:key
 *
 * The path `:key` is authoritative. Body MUST NOT carry a competing
 * `key` field. Shape enforcement lives in
 * `platform-configuration.validation.ts` (value-shape).
 */
import { AppError } from '../../shared/errors';
import {
  SAAS_PLATFORM_CONFIGURATION_KEYS,
  type SaaSPlatformConfigurationKey,
} from './platform-configuration.types';

const KEY_SET: ReadonlySet<string> = new Set(SAAS_PLATFORM_CONFIGURATION_KEYS);

function isKnownKey(value: string): value is SaaSPlatformConfigurationKey {
  return KEY_SET.has(value);
}

function rejectUnknownKey(raw: string): SaaSPlatformConfigurationKey {
  if (!isKnownKey(raw)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'key', message: `Unknown platform configuration key "${raw}".` },
    ]);
  }
  return raw;
}

function parsePositiveIntField(
  body: Record<string, unknown>,
  field: string,
): number {
  const raw = body[field];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw AppError.validation('Request validation failed.', [
      {
        field,
        message: `${field} must be a positive integer.`,
      },
    ]);
  }
  return raw;
}

export interface ParsedCreateConfigurationBody {
  value: unknown;
  description?: string;
}

export interface ParsedUpdateConfigurationBody {
  value: unknown;
  expectedVersion: number;
  description?: string;
}

export function parseCreateConfigurationBody(
  rawBody: unknown,
  pathKey: string,
): {
  key: SaaSPlatformConfigurationKey;
  body: ParsedCreateConfigurationBody;
} {
  const key = rejectUnknownKey(pathKey);
  if (typeof rawBody !== 'object' || rawBody === null) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const body = rawBody as Record<string, unknown>;
  // Path is authoritative; refuse competing `key` in body.
  if ('key' in body && body['key'] !== undefined && body['key'] !== null) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'key',
        message:
          'Body must not carry a competing "key"; the path :key is authoritative.',
      },
    ]);
  }
  if (!('value' in body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'value', message: 'value is required.' },
    ]);
  }
  let description: string | undefined;
  if ('description' in body && body['description'] !== undefined) {
    if (typeof body['description'] !== 'string') {
      throw AppError.validation('Request validation failed.', [
        { field: 'description', message: 'description must be a string.' },
      ]);
    }
    description = body['description'];
  }
  return {
    key,
    body: {
      value: body['value'],
      ...(description !== undefined ? { description } : {}),
    },
  };
}

export function parseUpdateConfigurationBody(
  rawBody: unknown,
  pathKey: string,
): {
  key: SaaSPlatformConfigurationKey;
  body: ParsedUpdateConfigurationBody;
} {
  const key = rejectUnknownKey(pathKey);
  if (typeof rawBody !== 'object' || rawBody === null) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const body = rawBody as Record<string, unknown>;
  if ('key' in body && body['key'] !== undefined && body['key'] !== null) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'key',
        message:
          'Body must not carry a competing "key"; the path :key is authoritative.',
      },
    ]);
  }
  if (!('value' in body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'value', message: 'value is required.' },
    ]);
  }
  const expectedVersion = parsePositiveIntField(body, 'expectedVersion');
  let description: string | undefined;
  if ('description' in body && body['description'] !== undefined) {
    if (typeof body['description'] !== 'string') {
      throw AppError.validation('Request validation failed.', [
        { field: 'description', message: 'description must be a string.' },
      ]);
    }
    description = body['description'];
  }
  return {
    key,
    body: {
      value: body['value'],
      expectedVersion,
      ...(description !== undefined ? { description } : {}),
    },
  };
}
