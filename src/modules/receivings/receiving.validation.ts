import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  RECEIVING_REQUEST_TYPES,
  RECEIVING_STATUSES,
  RECEIVING_TYPES,
  isReceivingRequestType,
  isReceivingStatus,
  isReceivingType,
  type CreateReceivingInput,
  type ReceivingFilters,
  type ReceivingRequestType,
  type ReceivingStatus,
  type ReceivingType,
  type UpdateReceivingInput,
} from './receiving.types';

type Detail = { field: string; message: string };
export type ValidationDetail = Detail;
const MAX_NOTES_LENGTH = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export function parseReceivingIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'id', message: 'id must be a valid UUID.' }]);
  }
  return value;
}

export function parseVendorIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'vendorId', message: 'vendorId must be a valid UUID.' }]);
  }
  return value;
}

export function parseBuildingIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'buildingId', message: 'buildingId must be a valid UUID.' }]);
  }
  return value;
}

export function parsePurchaseRequestIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'purchaseRequestId', message: 'purchaseRequestId must be a valid UUID.' }]);
  }
  return value;
}

export function parseServiceRequestIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'serviceRequestId', message: 'serviceRequestId must be a valid UUID.' }]);
  }
  return value;
}

function readUuidOrNull(
  value: unknown,
  field: string,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID or null.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readQuantity(
  value: unknown,
  details: Detail[],
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    details.push({
      field: 'quantity',
      message: 'Material receiving quantity must be a positive number.',
    });
    return undefined;
  }
  return value;
}

function readReceivingType(
  value: unknown,
  details: Detail[],
): ReceivingType | undefined {
  if (value === undefined) return undefined;
  if (!isReceivingType(value)) {
    details.push({
      field: 'receivingType',
      message: `receivingType must be one of: ${RECEIVING_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readStatus(
  value: unknown,
  details: Detail[],
): ReceivingStatus | undefined {
  if (value === undefined) return undefined;
  if (!isReceivingStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${RECEIVING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readId(
  value: unknown,
  field: string,
  required: boolean,
  details: Detail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readNotes(value: unknown, details: Detail[]): string | undefined {
  if (value === undefined || value === null) return undefined;
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
  details: Detail[],
): string | null | undefined {
  if (value === null) return null;
  return readNotes(value, details);
}

export function parseCreateReceivingBody(
  body: unknown,
): CreateReceivingInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  const requestType = readRequestType(body.requestType, details);
  const requestId = readId(body.requestId, 'requestId', true, details);
  const vendorId = readId(body.vendorId, 'vendorId', true, details);
  const receivingType = readReceivingType(body.receivingType, details);
  const materialRequestId = readUuidOrNull(
    body.materialRequestId,
    'materialRequestId',
    details,
  );
  const itemId = readUuidOrNull(body.itemId, 'itemId', details);
  const warehouseId = readUuidOrNull(body.warehouseId, 'warehouseId', details);
  const quantity = readQuantity(body.quantity, details);
  const uomId = readUuidOrNull(body.uomId, 'uomId', details);
  const notes = readNotes(body.notes, details);
  if (
    !requestType ||
    !requestId ||
    !vendorId ||
    !receivingType ||
    details.length
  ) {
    fail(details);
  }
  return {
    requestType,
    requestId,
    vendorId,
    receivingType,
    ...(materialRequestId === undefined ? {} : { materialRequestId }),
    ...(itemId === undefined ? {} : { itemId }),
    ...(warehouseId === undefined ? {} : { warehouseId }),
    ...(quantity === undefined ? {} : { quantity }),
    ...(uomId === undefined ? {} : { uomId }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseUpdateReceivingBody(body: unknown): UpdateReceivingInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  const notes = readNullableNotes(body.notes, details);
  if (details.length) fail(details);
  return { ...(notes === undefined ? {} : { notes }) };
}

export function parseReceivingFilters(query: unknown): ReceivingFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const status = readStatus(query.status, details);
  const receivingType = readReceivingType(query.receivingType, details);
  if (details.length) fail(details);
  return {
    ...(status === undefined ? {} : { status }),
    ...(receivingType === undefined ? {} : { receivingType }),
  };
}

function readRequestType(
  value: unknown,
  details: Detail[],
): ReceivingRequestType | undefined {
  if (!isReceivingRequestType(value)) {
    details.push({
      field: 'requestType',
      message: `requestType must be one of: ${RECEIVING_REQUEST_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}
