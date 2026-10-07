import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ASSET_CATEGORY_STATUSES,
  isAssetCategoryStatus,
  type AssetCategoryStatus,
  type CreateAssetCategoryInput,
  type UpdateAssetCategoryInput,
  type UpdateAssetCategoryStatusInput,
} from './asset-category.types';

/**
 * Category codes are the stable machine-readable reference identifier
 * (e.g. `HVAC`, `FIRE_PROTECTION`, `LIFT`). Normalized to uppercase, matching
 * every other code in the system: start with a letter; letters, digits,
 * hyphens, underscores.
 */
const ASSET_CATEGORY_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeAssetCategoryCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidAssetCategoryCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CODE_LENGTH &&
    ASSET_CATEGORY_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAssetCategoryIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'assetCategoryId',
        message: 'Asset category id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseAssetCategoryClientIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'Client id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateAssetCategoryBody(
  body: unknown,
): Omit<CreateAssetCategoryInput, 'clientId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const description = readOptionalDescription(body.description, details);
  const status = readStatus(body.status, details);

  if (!code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateAssetCategoryBody(
  body: unknown,
): UpdateAssetCategoryInput {
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
      : readOptionalDescription(body.description, details);
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateAssetCategoryStatusBody(
  body: unknown,
): UpdateAssetCategoryStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const status = readStatus(body.status, []);
  if (!status) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${ASSET_CATEGORY_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

function readCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Asset category code is required.' });
    return undefined;
  }

  const normalized = normalizeAssetCategoryCode(value);
  if (!isValidAssetCategoryCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Asset category code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Asset category name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Asset category name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Asset category name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readOptionalDescription(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    details.push({
      field: 'description',
      message: 'description must be a string.',
    });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }

  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    details.push({
      field: 'description',
      message: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): AssetCategoryStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isAssetCategoryStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${ASSET_CATEGORY_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}
