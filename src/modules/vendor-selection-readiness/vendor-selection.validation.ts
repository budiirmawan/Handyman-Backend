import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VENDOR_SELECTION_READINESS,
  VENDOR_SELECTION_REQUEST_TYPES,
  isVendorSelectionReadiness,
  isVendorSelectionRequestType,
  type CreateVendorSelectionInput,
  type VendorSelectionFilters,
  type VendorSelectionReadiness,
  type VendorSelectionRequestType,
} from './vendor-selection.types';

type Detail = { field: string; message: string };
export type ValidationDetail = Detail;
const MAX_NOTES_LENGTH = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export function parseVendorSelectionIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'vendorSelectionId', message: 'id must be a valid UUID.' }]);
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

export function parseCreateVendorSelectionBody(
  body: unknown,
): CreateVendorSelectionInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  const requestType = readRequestType(body.requestType, details);
  const requestId = readId(body.requestId, 'requestId', true, details);
  const vendorId = readId(body.vendorId, 'vendorId', true, details);
  const notes = readNotes(body.notes, details);
  if (!requestType || !requestId || !vendorId || details.length) fail(details);
  return {
    requestType,
    requestId,
    vendorId,
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseVendorSelectionFilters(query: unknown): VendorSelectionFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const readiness = readReadiness(query.readiness, details);
  if (details.length) fail(details);
  return { ...(readiness === undefined ? {} : { readiness }) };
}

function readRequestType(
  value: unknown,
  details: Detail[],
): VendorSelectionRequestType | undefined {
  if (!isVendorSelectionRequestType(value)) {
    details.push({
      field: 'requestType',
      message: `requestType must be one of: ${VENDOR_SELECTION_REQUEST_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readReadiness(
  value: unknown,
  details: Detail[],
): VendorSelectionReadiness | undefined {
  if (value === undefined) return undefined;
  if (!isVendorSelectionReadiness(value)) {
    details.push({
      field: 'readiness',
      message: `readiness must be one of: ${VENDOR_SELECTION_READINESS.join(', ')}.`,
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
