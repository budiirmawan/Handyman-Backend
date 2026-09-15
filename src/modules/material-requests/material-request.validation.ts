import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isMaterialRequestStatus,
  MATERIAL_REQUEST_STATUSES,
  type CreateMaterialRequestInput,
  type MaterialRequestFilters,
  type MaterialRequestStatus,
  type UpdateMaterialRequestInput,
} from './material-request.types';

const MAX_NOTES_LENGTH = 1000;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function readUuidOrNull(
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
    details.push({
      field,
      message: `${field} must be a valid UUID or null.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readQuantity(
  value: unknown,
  details: ValidationDetail[],
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    details.push({
      field: 'quantity',
      message: 'Quantity must be a positive number.',
    });
    return undefined;
  }
  return value;
}

function readRequiredDate(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !isValidIsoDate(value)) {
    details.push({
      field: 'requiredDate',
      message: 'requiredDate must be a valid ISO date string or null.',
    });
    return undefined;
  }
  return value;
}

function readNotes(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'notes', message: 'notes must be a string.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTES_LENGTH) {
    details.push({
      field: 'notes',
      message: `notes must be at most ${MAX_NOTES_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readNullableNotes(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return readNotes(value, details);
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): MaterialRequestStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMaterialRequestStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${MATERIAL_REQUEST_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

export function parseMaterialRequestIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'materialRequestId',
        message: 'Material request id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parsePurchaseRequestIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'purchaseRequestId',
        message: 'Purchase request id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseItemIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'itemId', message: 'Item id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseMaterialRequestFilters(query: unknown): MaterialRequestFilters {
  if (!isRecord(query)) {
    return {};
  }

  const details: ValidationDetail[] = [];
  const status = readStatus(query.status, details);
  const purchaseRequestId =
    query.purchaseRequestId === undefined
      ? undefined
      : readUuid(query.purchaseRequestId, 'purchaseRequestId', details);
  const itemId =
    query.itemId === undefined ? undefined : readUuid(query.itemId, 'itemId', details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(status === undefined ? {} : { status }),
    ...(purchaseRequestId === undefined ? {} : { purchaseRequestId }),
    ...(itemId === undefined ? {} : { itemId }),
  };
}

export function parseCreateMaterialRequestBody(
  body: unknown,
): Omit<CreateMaterialRequestInput, 'purchaseRequestId' | 'requestedByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const itemId = readUuid(body.itemId, 'itemId', details);
  const quantity = readQuantity(body.quantity, details);
  const uomId = readUuidOrNull(body.uomId, 'uomId', details);
  const warehouseId = readUuidOrNull(body.warehouseId, 'warehouseId', details);
  const requiredDate = readRequiredDate(body.requiredDate, details);
  const notes = readNotes(body.notes, details);

  if (!itemId || quantity === undefined || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    itemId,
    quantity,
    ...(uomId === undefined ? {} : { uomId }),
    ...(warehouseId === undefined ? {} : { warehouseId }),
    ...(requiredDate === undefined ? {} : { requiredDate }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseUpdateMaterialRequestBody(
  body: unknown,
): UpdateMaterialRequestInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const quantity = readQuantity(body.quantity, details);
  const uomId = readUuidOrNull(body.uomId, 'uomId', details);
  const warehouseId = readUuidOrNull(body.warehouseId, 'warehouseId', details);
  const requiredDate = readRequiredDate(body.requiredDate, details);
  const notes = readNullableNotes(body.notes, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(quantity === undefined ? {} : { quantity }),
    ...(uomId === undefined ? {} : { uomId }),
    ...(warehouseId === undefined ? {} : { warehouseId }),
    ...(requiredDate === undefined ? {} : { requiredDate }),
    ...(notes === undefined ? {} : { notes }),
  };
}
