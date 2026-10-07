import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ASSET_REGISTRABLE_STATUSES,
  ASSET_STATUSES,
  isAssetStatus,
  isRegistrableAssetStatus,
  type AssetRegistrableStatus,
  type AssetStatus,
  type CreateAssetInput,
  type UpdateAssetInput,
  type UpdateAssetLocationInput,
  type UpdateAssetStatusInput,
} from './asset.types';

/**
 * Asset codes are the stable machine-readable registry identifier
 * (e.g. `AST-AHU-001`, `PUMP_01`). Normalized to uppercase, matching every
 * other code in the system: start with a letter; letters, digits, hyphens,
 * underscores.
 */
const ASSET_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_MANUFACTURER_LENGTH = 120;
const MAX_MODEL_LENGTH = 120;
const MAX_SERIAL_NUMBER_LENGTH = 120;
const MAX_STATUS_REASON_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeAssetCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidAssetCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CODE_LENGTH &&
    ASSET_CODE_PATTERN.test(code)
  );
}

/**
 * Serial numbers come from manufacturers, so they are NOT forced into the
 * internal code shape: they keep their original case and may contain dots,
 * slashes, and spaces. They are only trimmed and length-checked; an empty
 * string after trimming means "no serial number".
 */
export function normalizeSerialNumber(serialNumber: string): string {
  return serialNumber.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAssetIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'assetId', message: 'Asset id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseAssetBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

/** Optional `?status=` filter on the Building list route. */
export function parseAssetStatusQuery(raw: unknown): AssetStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = Array.isArray(raw) ? '' : String(raw).trim().toUpperCase();
  if (value === '') {
    return undefined;
  }

  if (!isAssetStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${ASSET_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return value;
}

export function parseCreateAssetBody(
  body: unknown,
): Omit<CreateAssetInput, 'buildingId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const assetCode = readAssetCode(body.assetCode, details);
  const assetName = readAssetName(body.assetName, details);
  const description = readOptionalText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const manufacturer = readOptionalText(
    body.manufacturer,
    'manufacturer',
    MAX_MANUFACTURER_LENGTH,
    details,
  );
  const model = readOptionalText(body.model, 'model', MAX_MODEL_LENGTH, details);
  const serialNumber = readOptionalText(
    body.serialNumber,
    'serialNumber',
    MAX_SERIAL_NUMBER_LENGTH,
    details,
  );
  const status = readRegistrableStatus(body.status, details);

  if (!assetCode || !assetName || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    assetCode,
    assetName,
    ...(description === undefined ? {} : { description }),
    ...(manufacturer === undefined ? {} : { manufacturer }),
    ...(model === undefined ? {} : { model }),
    ...(serialNumber === undefined ? {} : { serialNumber }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateAssetBody(body: unknown): UpdateAssetInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const assetName =
    body.assetName === undefined
      ? undefined
      : readAssetName(body.assetName, details);
  const description = readNullableText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const manufacturer = readNullableText(
    body.manufacturer,
    'manufacturer',
    MAX_MANUFACTURER_LENGTH,
    details,
  );
  const model = readNullableText(body.model, 'model', MAX_MODEL_LENGTH, details);
  const serialNumber = readNullableText(
    body.serialNumber,
    'serialNumber',
    MAX_SERIAL_NUMBER_LENGTH,
    details,
  );
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);
  const assetCategoryId = readNullableUuid(
    body.assetCategoryId,
    'assetCategoryId',
    details,
  );
  const assetTypeId = readNullableUuid(
    body.assetTypeId,
    'assetTypeId',
    details,
  );
  const functionalLocationId = readNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(assetName === undefined ? {} : { assetName }),
    ...(assetCategoryId === undefined ? {} : { assetCategoryId }),
    ...(assetTypeId === undefined ? {} : { assetTypeId }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(description === undefined ? {} : { description }),
    ...(manufacturer === undefined ? {} : { manufacturer }),
    ...(model === undefined ? {} : { model }),
    ...(serialNumber === undefined ? {} : { serialNumber }),
    ...(status === undefined ? {} : { status }),
  };
}

/**
 * BE-05C — `PATCH /assets/:id/location` body.
 *
 * Only `functionalLocationId` is accepted: the finer hierarchy is resolved
 * from BE-04, never supplied by the caller. The field is REQUIRED here (a
 * UUID binds, an explicit null clears) so the dedicated endpoint always has
 * an unambiguous intent.
 */
export function parseUpdateAssetLocationBody(
  body: unknown,
): UpdateAssetLocationInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  if (body.functionalLocationId === undefined) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'functionalLocationId',
        message:
          'functionalLocationId is required (a UUID to bind, or null to clear).',
      },
    ]);
  }

  const details: ValidationDetail[] = [];
  const functionalLocationId = readNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return { functionalLocationId: functionalLocationId ?? null };
}

export function parseUpdateAssetStatusBody(
  body: unknown,
): UpdateAssetStatusInput {
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
        message: `Status must be one of: ${ASSET_STATUSES.join(', ')}.`,
      },
    ]);
  }

  // BE-05E: optional free-text reason preserved with the transition for
  // later Asset History (BE-05I).
  const details: ValidationDetail[] = [];
  const reason = readNullableText(
    body.reason,
    'reason',
    MAX_STATUS_REASON_LENGTH,
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return { status, ...(reason === undefined ? {} : { reason }) };
}

function readAssetCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'assetCode', message: 'Asset code is required.' });
    return undefined;
  }

  const normalized = normalizeAssetCode(value);
  if (!isValidAssetCode(normalized)) {
    details.push({
      field: 'assetCode',
      message:
        'Asset code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readAssetName(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'assetName', message: 'Asset name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'assetName', message: 'Asset name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'assetName',
      message: `Asset name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

/** Create-body optional text: omitted or null both mean "not provided". */
function readOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }

  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

/**
 * Update-body optional text: an explicit null (or an empty string) clears the
 * stored value; omitting the field leaves it untouched.
 */
function readNullableText(
  value: unknown,
  field: string,
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
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

/**
 * BE-05B classification reference: a UUID assigns, an explicit null clears,
 * omission leaves the current value untouched.
 */
function readNullableUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID or null.` });
    return undefined;
  }

  return value.trim().toLowerCase();
}

/**
 * Registration status reader: only a non-terminal starting state is allowed
 * (BE-05E lifecycle). `UNDER_MAINTENANCE` / `RETIRED` are reached through a
 * transition, never at creation.
 */
function readRegistrableStatus(
  value: unknown,
  details: ValidationDetail[],
): AssetRegistrableStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isRegistrableAssetStatus(value)) {
    details.push({
      field: 'status',
      message: `A new asset must be registered with one of: ${ASSET_REGISTRABLE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): AssetStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isAssetStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${ASSET_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}
