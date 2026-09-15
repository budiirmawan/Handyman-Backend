import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  PURCHASE_ORDER_CURRENCIES,
  PURCHASE_ORDER_STATUSES,
  isPurchaseOrderCurrency,
  isPurchaseOrderStatus,
  type CreatePurchaseOrderInput,
  type IssuePurchaseOrderInput,
  type PurchaseOrderCurrency,
  type PurchaseOrderFilters,
  type PurchaseOrderStatus,
  type UpdatePurchaseOrderInput,
} from './purchase-order.types';

type Detail = { field: string; message: string };
export type ValidationDetail = Detail;

/**
 * PO identity foundation. Same shape as the Vendor Invoice number pattern so
 * commercial documents share one numbering vocabulary; normalized uppercase
 * and unique per Client at the database level.
 */
const PO_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_\-/]{1,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_VENDOR_REFERENCE_LENGTH = 255;
const MAX_NOTES_LENGTH = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  }
  return value;
}

export const parsePurchaseOrderIdParam = (raw: string): string =>
  parseId(raw, 'purchaseOrderId');

export function parseCreatePurchaseOrderBody(
  body: unknown,
): CreatePurchaseOrderInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: Detail[] = [];

  // Frozen decision 1: the readiness reference is the ONLY context input.
  // Client, Building, Vendor and the request reference are derived from it.
  const poReadinessId = readId(
    body.poReadinessId,
    'poReadinessId',
    true,
    details,
  );
  const poNumber = readPoNumber(body.poNumber, details);
  const poDate = readDate(body.poDate, 'poDate', true, details);
  const currency = readCurrency(body.currency, details);
  const vendorReference = readString(
    body.vendorReference,
    'vendorReference',
    MAX_VENDOR_REFERENCE_LENGTH,
    details,
  );
  const requiredDate = readNullableDate(
    body.requiredDate,
    'requiredDate',
    details,
  );
  const notes = readString(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  // Derived context may never be supplied by the caller — accepting it would
  // create a scope-widening side channel around BE-02 isolation.
  const derived = [
    'clientId',
    'buildingId',
    'vendorId',
    'requestType',
    'purchaseRequestId',
    'serviceRequestId',
    'status',
  ].find((field) => body[field] !== undefined);
  if (derived) {
    details.push({
      field: derived,
      message:
        'This field is derived from the Purchase Order Readiness and must not be supplied.',
    });
  }

  if (!poReadinessId || !poNumber || !poDate || !currency || details.length) {
    fail(details);
  }

  return {
    poReadinessId,
    poNumber,
    poDate,
    currency,
    ...(vendorReference !== undefined ? { vendorReference } : {}),
    ...(requiredDate !== undefined ? { requiredDate } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseUpdatePurchaseOrderBody(
  body: unknown,
): UpdatePurchaseOrderInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  // A commitment is never silently re-pointed at another vendor, request or
  // readiness, and its identity/scope never changes.
  const immutable = [
    'clientId',
    'buildingId',
    'vendorId',
    'poNumber',
    'requestType',
    'purchaseRequestId',
    'serviceRequestId',
    'poReadinessId',
    'status',
    // PART 03 — issuance provenance is set by the issue command only.
    'issuedAt',
    'issuedByUserId',
    'cancelledAt',
    'cancelledByUserId',
  ].find((field) => body[field] !== undefined);
  if (immutable) {
    fail([
      { field: immutable, message: 'This Purchase Order field is immutable.' },
    ]);
  }

  const details: Detail[] = [];
  const poDate =
    body.poDate === undefined
      ? undefined
      : readDate(body.poDate, 'poDate', true, details);
  const currency =
    body.currency === undefined
      ? undefined
      : readCurrency(body.currency, details);
  const vendorReference =
    body.vendorReference === null
      ? null
      : readString(
          body.vendorReference,
          'vendorReference',
          MAX_VENDOR_REFERENCE_LENGTH,
          details,
        );
  const requiredDate = readNullableDate(
    body.requiredDate,
    'requiredDate',
    details,
  );
  const notes =
    body.notes === null
      ? null
      : readString(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  const result: UpdatePurchaseOrderInput = {
    ...(poDate ? { poDate } : {}),
    ...(currency ? { currency } : {}),
    ...(vendorReference !== undefined ? { vendorReference } : {}),
    ...(requiredDate !== undefined ? { requiredDate } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };

  if (Object.keys(result).length === 0 && details.length === 0) {
    details.push({
      field: 'body',
      message: 'At least one draft field is required.',
    });
  }
  if (details.length) fail(details);
  return result;
}

export function parsePurchaseOrderFilters(
  query: unknown,
): PurchaseOrderFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const vendorId = readId(query.vendorId, 'vendorId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const purchaseRequestId = readId(
    query.purchaseRequestId,
    'purchaseRequestId',
    false,
    details,
  );
  const serviceRequestId = readId(
    query.serviceRequestId,
    'serviceRequestId',
    false,
    details,
  );
  const status = readStatus(query.status, details);
  const poDateFrom = readDate(query.poDateFrom, 'poDateFrom', false, details);
  const poDateTo = readDate(query.poDateTo, 'poDateTo', false, details);

  if (poDateFrom && poDateTo && poDateTo < poDateFrom) {
    details.push({
      field: 'poDateTo',
      message: 'poDateTo must be the same as or after poDateFrom.',
    });
  }
  if (details.length) fail(details);

  return {
    ...(vendorId ? { vendorId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(purchaseRequestId ? { purchaseRequestId } : {}),
    ...(serviceRequestId ? { serviceRequestId } : {}),
    ...(status ? { status } : {}),
    ...(poDateFrom ? { poDateFrom } : {}),
    ...(poDateTo ? { poDateTo } : {}),
  };
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

function readPoNumber(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'poNumber', message: 'poNumber is required.' });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!PO_NUMBER_PATTERN.test(normalized)) {
    details.push({
      field: 'poNumber',
      message: 'poNumber has an invalid format.',
    });
    return undefined;
  }
  return normalized;
}

function readDate(
  value: unknown,
  field: string,
  required: boolean,
  details: Detail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== 'string' ||
    !DATE_PATTERN.test(value) ||
    !isCalendarDate(value)
  ) {
    details.push({
      field,
      message: `${field} ${required ? 'is required and ' : ''}must be a valid YYYY-MM-DD date.`,
    });
    return undefined;
  }
  return value;
}

function readNullableDate(
  value: unknown,
  field: string,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readDate(value, field, true, details);
}

function isCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function readCurrency(
  value: unknown,
  details: Detail[],
): PurchaseOrderCurrency | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'currency',
      message: `currency must be one of: ${PURCHASE_ORDER_CURRENCIES.join(', ')}.`,
    });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!isPurchaseOrderCurrency(normalized)) {
    details.push({
      field: 'currency',
      message: `currency must be one of: ${PURCHASE_ORDER_CURRENCIES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
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

function readStatus(
  value: unknown,
  details: Detail[],
): PurchaseOrderStatus | undefined {
  if (value === undefined) return undefined;
  if (!isPurchaseOrderStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${PURCHASE_ORDER_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

// ─── PART 03: Issuance ──────────────────────────────────────────

/**
 * Validates the issue-command body.
 *
 * The body carries an optional issuance note ONLY. Status, issuance
 * provenance and every readiness field are backend-derived: a caller can
 * neither declare itself READY, nor stamp `issuedAt` / `issuedByUserId`, nor
 * hand-wave past a blocker. BE-17F remains the sole readiness authority.
 */
export function parseIssuePurchaseOrderBody(
  body: unknown,
): IssuePurchaseOrderInput {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const derived = [
    'status',
    'issuedAt',
    'issuedByUserId',
    'issuable',
    'blockers',
    'poReadiness',
    'poReadinessId',
    'readiness',
    'clientId',
    'buildingId',
    'vendorId',
    'purchaseRequestId',
    'serviceRequestId',
  ].find((field) => body[field] !== undefined);
  if (derived) {
    fail([
      {
        field: derived,
        message: 'This field is derived by the backend and cannot be supplied.',
      },
    ]);
  }

  const details: Detail[] = [];
  const notes = readString(body.notes, 'notes', MAX_NOTES_LENGTH, details);
  if (details.length > 0) fail(details);

  return notes ? { notes } : {};
}
