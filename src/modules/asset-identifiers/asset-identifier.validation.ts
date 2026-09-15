import { randomBytes } from 'node:crypto';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ASSET_IDENTIFIER_STATUSES,
  ASSET_IDENTIFIER_TYPES,
  isAssetIdentifierStatus,
  isAssetIdentifierType,
  type AssetIdentifierStatus,
  type AssetIdentifierType,
  type CreateAssetIdentifierInput,
  type UpdateAssetIdentifierInput,
  type UpdateAssetIdentifierStatusInput,
} from './asset-identifier.types';

/**
 * Identifier values are printed on labels and typed/scanned in the field, so
 * the format is deliberately conservative: uppercase letters, digits,
 * hyphens, and underscores only. No spaces, no punctuation that a scanner or
 * URL path could mangle.
 */
const IDENTIFIER_VALUE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;
const MIN_VALUE_LENGTH = 6;
const MAX_VALUE_LENGTH = 64;

/** Prefix + 20 random base32 chars ≈ 100 bits of entropy: unguessable. */
const GENERATED_VALUE_PREFIX = 'AST-';
const GENERATED_VALUE_BYTES = 13;
/** Crockford-style alphabet: no I, L, O, U — avoids field transcription errors. */
const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeIdentifierValue(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidIdentifierValue(value: string): boolean {
  return (
    value.length >= MIN_VALUE_LENGTH &&
    value.length <= MAX_VALUE_LENGTH &&
    IDENTIFIER_VALUE_PATTERN.test(value)
  );
}

/**
 * Mints an OPAQUE identifier value.
 *
 * The value carries no Client, Building, Asset, or sequence information — it
 * is random, so a label reveals nothing about the estate and neighbouring
 * assets cannot be enumerated from one scanned code.
 */
export function generateIdentifierValue(): string {
  const bytes = randomBytes(GENERATED_VALUE_BYTES);
  let value = '';
  for (const byte of bytes) {
    value += BASE32_ALPHABET[byte % BASE32_ALPHABET.length];
  }
  return `${GENERATED_VALUE_PREFIX}${value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseIdentifierAssetIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'assetId', message: 'Asset id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseIdentifierIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'identifierId', message: 'Identifier id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

/** The `:identifier` path segment of the resolve route. */
export function parseIdentifierValueParam(raw: string): string {
  const value = normalizeIdentifierValue(raw);
  if (!isValidIdentifierValue(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'identifier',
        message:
          'Identifier value must be 6-64 characters of uppercase letters, digits, hyphens, and underscores.',
      },
    ]);
  }
  return value;
}

export function parseCreateAssetIdentifierBody(
  body: unknown,
): Omit<CreateAssetIdentifierInput, 'assetId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const identifierType = readType(body.identifierType, details);
  const identifierValue = readOptionalValue(body.identifierValue, details);
  const status = readStatus(body.status, details);

  if (!identifierType || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    identifierType,
    ...(identifierValue === undefined ? {} : { identifierValue }),
    ...(status === undefined ? {} : { status }),
  };
}

/**
 * Only `status` is patchable — the value and the owning Asset are immutable
 * because a physical label already exists in the field.
 */
export function parseUpdateAssetIdentifierBody(
  body: unknown,
): UpdateAssetIdentifierInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateAssetIdentifierStatusBody(
  body: unknown,
): UpdateAssetIdentifierStatusInput {
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
        message: `Status must be one of: ${ASSET_IDENTIFIER_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

function readType(
  value: unknown,
  details: ValidationDetail[],
): AssetIdentifierType | undefined {
  if (value === undefined || value === null) {
    details.push({
      field: 'identifierType',
      message: `identifierType is required and must be one of: ${ASSET_IDENTIFIER_TYPES.join(', ')}.`,
    });
    return undefined;
  }

  const normalized =
    typeof value === 'string' ? value.trim().toUpperCase() : value;
  if (!isAssetIdentifierType(normalized)) {
    details.push({
      field: 'identifierType',
      message: `identifierType must be one of: ${ASSET_IDENTIFIER_TYPES.join(', ')}.`,
    });
    return undefined;
  }

  return normalized;
}

function readOptionalValue(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    details.push({
      field: 'identifierValue',
      message: 'identifierValue must be a string.',
    });
    return undefined;
  }

  const normalized = normalizeIdentifierValue(value);
  if (normalized === '') {
    return undefined;
  }

  if (!isValidIdentifierValue(normalized)) {
    details.push({
      field: 'identifierValue',
      message: `identifierValue must be ${MIN_VALUE_LENGTH}-${MAX_VALUE_LENGTH} characters of uppercase letters, digits, hyphens, and underscores.`,
    });
    return undefined;
  }

  return normalized;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): AssetIdentifierStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isAssetIdentifierStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${ASSET_IDENTIFIER_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}
