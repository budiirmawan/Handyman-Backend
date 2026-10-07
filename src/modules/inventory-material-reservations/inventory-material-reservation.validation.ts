import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isMaterialReservationStatus,
  MATERIAL_RESERVATION_STATUSES,
  type CreateMaterialReservationInput,
  type MaterialReservationFilters,
  type MaterialReservationStatus,
} from './inventory-material-reservation.types';

const MAX_NOTES_LENGTH = 1000;

type ValidationDetail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return readUuid(value, field, details);
}

function readUuidOrNull(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readUuid(value, field, details) ?? null;
}

function readPositiveNumber(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    details.push({ field, message: `${field} must be a positive number.` });
    return undefined;
  }
  return value;
}

function readNotes(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    details.push({ field: 'notes', message: 'notes must be a string.' });
    return undefined;
  }
  const notes = value.trim();
  if (notes.length > MAX_NOTES_LENGTH) {
    details.push({
      field: 'notes',
      message: `notes must be at most ${MAX_NOTES_LENGTH} characters.`,
    });
    return undefined;
  }
  return notes;
}

export function parseMaterialReservationIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Material reservation id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
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

export function parseCreateMaterialReservationBody(
  body: unknown,
): Omit<CreateMaterialReservationInput, 'materialRequestId' | 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const warehouseId = readUuid(body.warehouseId, 'warehouseId', details);
  const itemId = readOptionalUuid(body.itemId, 'itemId', details);
  const uomId = readUuidOrNull(body.uomId, 'uomId', details);
  const quantity = readPositiveNumber(body.quantity, 'quantity', details);
  const notes = readNotes(body.notes, details);

  if (!warehouseId || quantity === undefined || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    warehouseId,
    ...(itemId === undefined ? {} : { itemId }),
    ...(uomId === undefined ? {} : { uomId }),
    quantity,
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseMaterialReservationFilters(
  query: unknown,
): Pick<MaterialReservationFilters, 'status'> {
  if (!isRecord(query) || query.status === undefined) return {};
  if (!isMaterialReservationStatus(query.status)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${MATERIAL_RESERVATION_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return { status: query.status as MaterialReservationStatus };
}

export type { ValidationDetail };
