import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  PO_READINESS_REQUEST_TYPES,
  PO_READINESS_STATUSES,
  isPOReadinessRequestType,
  isPOReadinessStatus,
  type CreatePOReadinessInput,
  type POReadinessFilters,
  type POReadinessRequestType,
  type POReadinessStatus,
  type UpdatePOReadinessInput,
} from './purchase-order-readiness.types';

type Detail = { field: string; message: string };
export type ValidationDetail = Detail;
const MAX_NOTES_LENGTH = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function parsePOReadinessIdParam(raw: string): string {
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

export function parseCreatePOReadinessBody(
  body: unknown,
): CreatePOReadinessInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  const requestType = readRequestType(body.requestType, details);
  const requestId = readId(body.requestId, 'requestId', true, details);
  const vendorId = readId(body.vendorId, 'vendorId', true, details);
  const requiredDate = readRequiredDate(body.requiredDate, details);
  const notes = readNotes(body.notes, details);
  if (!requestType || !requestId || !vendorId || details.length) fail(details);
  return {
    requestType,
    requestId,
    vendorId,
    ...(requiredDate === undefined ? {} : { requiredDate }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseUpdatePOReadinessBody(
  body: unknown,
): UpdatePOReadinessInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  const requiredDate = readRequiredDate(body.requiredDate, details);
  const notes = readNullableNotes(body.notes, details);
  if (details.length) fail(details);
  return {
    ...(requiredDate === undefined ? {} : { requiredDate }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parsePOReadinessFilters(query: unknown): POReadinessFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const readiness = readReadiness(query.readiness, details);
  if (details.length) fail(details);
  return { ...(readiness === undefined ? {} : { readiness }) };
}

function readRequestType(
  value: unknown,
  details: Detail[],
): POReadinessRequestType | undefined {
  if (!isPOReadinessRequestType(value)) {
    details.push({
      field: 'requestType',
      message: `requestType must be one of: ${PO_READINESS_REQUEST_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readReadiness(
  value: unknown,
  details: Detail[],
): POReadinessStatus | undefined {
  if (value === undefined) return undefined;
  if (!isPOReadinessStatus(value)) {
    details.push({
      field: 'readiness',
      message: `readiness must be one of: ${PO_READINESS_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readRequiredDate(
  value: unknown,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !isValidIsoDate(value)) {
    details.push({
      field: 'requiredDate',
      message: 'requiredDate must be a valid ISO date string or null.',
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
    details.push({ field: 'notes', message: `notes must be at most ${MAX_NOTES_LENGTH} characters.` });
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
