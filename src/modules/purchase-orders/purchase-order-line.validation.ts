import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  PO_LINE_REQUEST_TYPES,
  isPurchaseOrderLineRequestType,
  type AddPurchaseOrderLineInput,
  type PurchaseOrderLineRequestType,
  type UpdatePurchaseOrderLineInput,
} from './purchase-order-line.types';

type Detail = { field: string; message: string };

const MAX_DESCRIPTION_LENGTH = 500;
const MAX_NOTES_LENGTH = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export const parsePurchaseOrderLineIdParam = (raw: string): string => {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([
      {
        field: 'purchaseOrderLineId',
        message: 'purchaseOrderLineId must be a valid UUID.',
      },
    ]);
  }
  return value;
};

export function parseAddPurchaseOrderLineBody(
  body: unknown,
): AddPurchaseOrderLineInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: Detail[] = [];
  const requestLineType = readRequestLineType(body.requestLineType, details);
  const requestLineId = readId(body.requestLineId, 'requestLineId', details);
  const unitPrice = readUnitPrice(body.unitPrice, details);
  const description = readString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const notes = readString(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  /**
   * Derived snapshots may never be supplied by the caller. Accepting any of
   * these would let a client invent a quantity and turn the PO Line into a
   * competing quantity authority — Material Request stays authoritative.
   */
  const derived = [
    'clientId',
    'buildingId',
    'purchaseOrderId',
    'lineNumber',
    'itemId',
    'uomId',
    'quantitySnapshot',
    'quantity',
    'approvedQuantity',
    'orderedQuantity',
    'receivedQuantity',
    'remainingQuantity',
    'lineAmount',
    'materialRequestId',
    'serviceRequestId',
  ].find((field) => body[field] !== undefined);
  if (derived) {
    details.push({
      field: derived,
      message:
        'This field is derived from the Purchase Order and the originating request line and must not be supplied.',
    });
  }

  if (!requestLineType || !requestLineId || unitPrice === undefined || details.length) {
    fail(details);
  }

  return {
    requestLineType,
    requestLineId,
    unitPrice,
    ...(description !== undefined && description !== null
      ? { description }
      : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseUpdatePurchaseOrderLineBody(
  body: unknown,
): UpdatePurchaseOrderLineInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  // Linkage, derived snapshots and ordering are immutable.
  const immutable = [
    'clientId',
    'buildingId',
    'purchaseOrderId',
    'lineNumber',
    'requestLineType',
    'requestLineId',
    'materialRequestId',
    'serviceRequestId',
    'itemId',
    'uomId',
    'quantitySnapshot',
    'quantity',
    'approvedQuantity',
    'lineAmount',
  ].find((field) => body[field] !== undefined);
  if (immutable) {
    fail([
      {
        field: immutable,
        message: 'This Purchase Order Line field is immutable.',
      },
    ]);
  }

  const details: Detail[] = [];
  const unitPrice =
    body.unitPrice === undefined
      ? undefined
      : readUnitPrice(body.unitPrice, details);
  const description = readString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const notes =
    body.notes === null
      ? null
      : readString(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  const result: UpdatePurchaseOrderLineInput = {
    ...(unitPrice !== undefined ? { unitPrice } : {}),
    ...(description !== undefined && description !== null
      ? { description }
      : {}),
    ...(notes !== undefined ? { notes } : {}),
  };

  if (Object.keys(result).length === 0 && details.length === 0) {
    details.push({
      field: 'body',
      message: 'At least one updatable field is required.',
    });
  }
  if (details.length) fail(details);
  return result;
}

function readRequestLineType(
  value: unknown,
  details: Detail[],
): PurchaseOrderLineRequestType | undefined {
  if (!isPurchaseOrderLineRequestType(value)) {
    details.push({
      field: 'requestLineType',
      message: `requestLineType must be one of: ${PO_LINE_REQUEST_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readId(
  value: unknown,
  field: string,
  details: Detail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} is required and must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readUnitPrice(value: unknown, details: Detail[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    details.push({
      field: 'unitPrice',
      message: 'unitPrice must be a finite non-negative number.',
    });
    return undefined;
  }
  return value;
}

function readString(
  value: unknown,
  field: string,
  max: number,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const result = value.trim();
  if (!result) return null;
  if (result.length > max) {
    details.push({
      field,
      message: `${field} must be at most ${max} characters.`,
    });
    return undefined;
  }
  return result;
}
