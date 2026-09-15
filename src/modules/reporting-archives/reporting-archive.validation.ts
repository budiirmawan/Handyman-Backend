import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { REPORTING_EXPORT_DATASETS } from '../reporting-export';
import {
  REPORT_ARCHIVE_FORMATS,
  REPORT_ARCHIVE_STATUSES,
  type ReportArchiveListFilters,
  type ReportArchiveRequestInput,
} from './reporting-archive.types';

/** CR-BE-EXP-01 PART 01 — request/archive validation only; no rendering. */

type ValidationDetail = { field: string; message: string };
type JsonObject = Record<string, unknown>;

export const MAX_FILTER_SNAPSHOT_BYTES = 32_768;
const MAX_JSON_DEPTH = 5;
const MAX_JSON_KEYS = 100;
const MAX_JSON_ARRAY_ITEMS = 100;
const MAX_JSON_STRING_LENGTH = 2_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

const FORBIDDEN_JSON_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'password',
  'passwordhash',
  'credentials',
  'credential',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'secret',
  'apikey',
  'storagereference',
  'signedurl',
  'filebytes',
  'sql',
  'html',
  'template',
  'clientid',
  'buildingid',
  'buildingids',
  'scope',
  'requestedscope',
  'resolvedscope',
  'dataset',
  'reporttype',
  'format',
]);

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function isRecord(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readUuid(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) {
      details.push({ field, message: `${field} is required.` });
    }
    return undefined;
  }
  if (Array.isArray(value) || typeof value !== 'string') {
    details.push({ field, message: `${field} must be a single UUID.` });
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return normalized;
}

function readEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  required: boolean,
  details: ValidationDetail[],
): T | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (Array.isArray(value) || typeof value !== 'string') {
    details.push({ field, message: `${field} must be a single value.` });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!(allowed as readonly string[]).includes(normalized)) {
    details.push({
      field,
      message: `${field} must be one of: ${allowed.join(', ')}.`,
    });
    return undefined;
  }
  return normalized as T;
}

function normalizeJsonValue(
  value: unknown,
  field: string,
  depth: number,
): unknown {
  if (depth > MAX_JSON_DEPTH) {
    fail([{ field, message: `JSON nesting must not exceed ${MAX_JSON_DEPTH} levels.` }]);
  }

  if (value === null || typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      fail([{ field, message: `${field} contains a string that is too long.` }]);
    }
    if (value.includes('\u0000')) {
      fail([{ field, message: `${field} must not contain NUL characters.` }]);
    }
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail([{ field, message: `${field} must contain only finite numbers.` }]);
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      fail([{ field, message: `${field} contains too many array items.` }]);
    }
    return value.map((item, index) =>
      normalizeJsonValue(item, `${field}[${index}]`, depth + 1),
    );
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > MAX_JSON_KEYS) {
      fail([{ field, message: `${field} contains too many object keys.` }]);
    }

    const normalized: JsonObject = {};
    for (const key of keys.sort()) {
      if (FORBIDDEN_JSON_KEYS.has(key.toLowerCase())) {
        fail([{ field: `${field}.${key}`, message: 'This field is not allowed.' }]);
      }
      normalized[key] = normalizeJsonValue(
        value[key],
        `${field}.${key}`,
        depth + 1,
      );
    }
    return normalized;
  }

  fail([{ field, message: `${field} must contain JSON values only.` }]);
}

/** Validates and canonicalizes the bounded filter object persisted in JSONB. */
export function normalizeReportFilterSnapshot(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    fail([{ field: 'filters', message: 'filters must be a JSON object.' }]);
  }

  const normalized = normalizeJsonValue(value, 'filters', 0) as JsonObject;
  const serialized = JSON.stringify(normalized) ?? '';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FILTER_SNAPSHOT_BYTES) {
    fail([
      {
        field: 'filters',
        message: `filters must be at most ${MAX_FILTER_SNAPSHOT_BYTES} bytes when serialized.`,
      },
    ]);
  }
  return normalized;
}

export function parseCreateReportArchiveBody(
  value: unknown,
): ReportArchiveRequestInput {
  if (!isRecord(value)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const allowed = new Set([
    'clientId',
    'buildingId',
    'buildingIds',
    'dataset',
    'format',
    'filters',
  ]);
  const details: ValidationDetail[] = [];
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      details.push({ field: key, message: `${key} is not allowed.` });
    }
  }

  const clientId = readUuid(value.clientId, 'clientId', true, details);
  const buildingId = readUuid(value.buildingId, 'buildingId', false, details);
  const dataset = readEnum(
    value.dataset,
    'dataset',
    REPORTING_EXPORT_DATASETS,
    true,
    details,
  );
  const format = readEnum(
    value.format,
    'format',
    REPORT_ARCHIVE_FORMATS,
    true,
    details,
  );

  let buildingIds: string[] | undefined;
  if (value.buildingIds !== undefined && value.buildingIds !== null) {
    if (!Array.isArray(value.buildingIds) || value.buildingIds.length === 0) {
      details.push({
        field: 'buildingIds',
        message: 'buildingIds must be a non-empty array of UUIDs.',
      });
    } else {
      const seen = new Set<string>();
      buildingIds = [];
      for (const [index, raw] of value.buildingIds.entries()) {
        if (typeof raw !== 'string' || !isValidUuid(raw.trim())) {
          details.push({
            field: `buildingIds[${index}]`,
            message: 'Each buildingIds item must be a valid UUID.',
          });
          continue;
        }
        const id = raw.trim().toLowerCase();
        if (!seen.has(id)) {
          seen.add(id);
          buildingIds.push(id);
        }
      }
      if (buildingIds.length === 0) buildingIds = undefined;
    }
  }

  if (buildingId && buildingIds && buildingIds.length > 0) {
    details.push({
      field: 'buildingIds',
      message: 'buildingId and buildingIds are mutually exclusive.',
    });
  }

  if (details.length > 0) fail(details);

  const filters = normalizeReportFilterSnapshot(value.filters);
  if (!clientId || !dataset || !format) {
    fail([
      { field: 'body', message: 'clientId, dataset, and format are required.' },
    ]);
  }

  return {
    clientId,
    ...(buildingId ? { buildingId } : {}),
    ...(buildingIds ? { buildingIds } : {}),
    dataset,
    format,
    filters,
  };
}

/** Header-level idempotency key. The raw value is hashed before persistence. */
export function parseReportIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) {
    fail([{ field: 'Idempotency-Key', message: 'Idempotency-Key must not be empty.' }]);
  }
  if (normalized.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    fail([
      {
        field: 'Idempotency-Key',
        message: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      },
    ]);
  }
  if (/[\r\n\u0000]/.test(normalized)) {
    fail([{ field: 'Idempotency-Key', message: 'Idempotency-Key contains invalid characters.' }]);
  }
  return normalized;
}

export function parseReportArchiveId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'id must be a valid UUID.' },
    ]);
  }
  return normalized;
}

export function parseReportArchiveListQuery(
  query: Record<string, unknown>,
): ReportArchiveListFilters {
  const details: ValidationDetail[] = [];
  const allowed = new Set([
    'clientId',
    'buildingId',
    'dataset',
    'format',
    'status',
    'page',
    'pageSize',
  ]);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) {
      details.push({ field: key, message: `${key} is not allowed.` });
    }
  }

  const clientId = readUuid(query.clientId, 'clientId', false, details);
  const buildingId = readUuid(query.buildingId, 'buildingId', false, details);
  const dataset = readEnum(
    query.dataset,
    'dataset',
    REPORTING_EXPORT_DATASETS,
    false,
    details,
  );
  const format = readEnum(
    query.format,
    'format',
    REPORT_ARCHIVE_FORMATS,
    false,
    details,
  );
  const status = readEnum(
    query.status,
    'status',
    REPORT_ARCHIVE_STATUSES,
    false,
    details,
  );

  if (details.length > 0) fail(details);

  return {
    ...(clientId ? { clientId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(dataset ? { dataset } : {}),
    ...(format ? { format } : {}),
    ...(status ? { status } : {}),
  };
}
