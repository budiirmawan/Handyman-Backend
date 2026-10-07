import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { CreateWorkOrderMaterialUsageInput } from './inventory-wo-material-usage.types';

type Detail = { field: string; message: string };

/** CUR-02 PART 03 — format gate; ACTIVE + Client-allowed authority is applied at the service boundary. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseUsageIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Usage id must be valid UUID.' },
    ]);
  }
  return v.toLowerCase();
}

export function parseWorkOrderIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'workOrderId', message: 'Work order id must be valid UUID.' },
    ]);
  }
  return v.toLowerCase();
}

export function parseWarehouseIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'warehouseId', message: 'Warehouse id must be valid UUID.' },
    ]);
  }
  return v.toLowerCase();
}

export function parseItemIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'itemId', message: 'Item id must be valid UUID.' },
    ]);
  }
  return v.toLowerCase();
}

export function parseClientIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'Client id must be valid UUID.' },
    ]);
  }
  return v.toLowerCase();
}

export function parseMaterialRequestIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'materialRequestId', message: 'Material request id must be valid UUID.' },
    ]);
  }
  return v.toLowerCase();
}

export function parseReservationIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'reservationId', message: 'Reservation id must be valid UUID.' },
    ]);
  }
  return v.toLowerCase();
}

export function parseBuildingIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be valid UUID.' },
    ]);
  }
  return v.toLowerCase();
}

export function parseCreateUsageBody(body: unknown): Omit<CreateWorkOrderMaterialUsageInput, 'usedByUserId' | 'workOrderId'> & { workOrderId?: string } {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Body must be JSON object.' },
    ]);
  }

  const details: Detail[] = [];

  const workOrderId = body.workOrderId === undefined ? undefined : readOptionalUuid(body.workOrderId, 'workOrderId', details);
  const warehouseId = readRequiredUuid(body.warehouseId, 'warehouseId', details);
  const itemId = readRequiredUuid(body.itemId, 'itemId', details);
  const materialRequestId = readOptionalUuid(
    body.materialRequestId,
    'materialRequestId',
    details,
  );
  const reservationId = readOptionalUuid(
    body.reservationId,
    'reservationId',
    details,
  );
  const quantity = readPositiveNumber(body.quantity, 'quantity', details);
  const uomId = readOptionalUuid(body.uomId, 'uomId', details);
  const unitCost = readOptionalNonNegativeNumber(body.unitCost, 'unitCost', details);
  const currency = readOptionalCurrency(body.currency, details);
  const costSource = readOptionalString(body.costSource, 'costSource', 120, details);
  const costReference = readOptionalString(body.costReference, 'costReference', 120, details);
  const usedAt = readOptionalDate(body.usedAt, 'usedAt', details);
  const reference = readOptionalString(body.reference, 'reference', 120, details);
  const notes = readOptionalString(body.notes, 'notes', 512, details);

  if ((currency || costSource || costReference) && unitCost === undefined) {
    details.push({
      field: 'unitCost',
      message: 'unitCost is required when currency/costSource/costReference is provided.',
    });
  }

  /* CUR-02 PART 03 — a costed usage must carry a governed currency. A
     non-costed usage (no unitCost) needs no currency and is not blocked. */
  if (unitCost !== undefined && currency === undefined) {
    details.push({
      field: 'currency',
      message: 'a governed currency is required when unitCost is provided.',
    });
  }

  if (!warehouseId || !itemId || quantity === undefined || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    workOrderId: workOrderId ?? '',
    warehouseId,
    itemId,
    ...(materialRequestId ? { materialRequestId } : {}),
    ...(reservationId ? { reservationId } : {}),
    quantity,
    ...(uomId ? { uomId } : {}),
    ...(unitCost === undefined ? {} : { unitCost }),
    ...(currency ? { currency } : {}),
    ...(costSource ? { costSource } : {}),
    ...(costReference ? { costReference } : {}),
    ...(usedAt ? { usedAt } : {}),
    ...(reference ? { reference } : {}),
    ...(notes ? { notes } : {}),
  } as any;
}

export function parseCreateUsageBodyForWorkOrder(
  body: unknown,
  pathWorkOrderId: string,
): Omit<CreateWorkOrderMaterialUsageInput, 'usedByUserId'> {
  const parsed = parseCreateUsageBody(body);
  if ((parsed as any).workOrderId && (parsed as any).workOrderId !== '' && (parsed as any).workOrderId !== pathWorkOrderId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'workOrderId', message: 'Work order id in body must match path.' },
    ]);
  }
  return {
    workOrderId: pathWorkOrderId,
    warehouseId: parsed.warehouseId,
    itemId: parsed.itemId,
    materialRequestId: (parsed as any).materialRequestId,
    reservationId: (parsed as any).reservationId,
    quantity: parsed.quantity,
    uomId: (parsed as any).uomId,
    unitCost: (parsed as any).unitCost,
    currency: (parsed as any).currency,
    costSource: (parsed as any).costSource,
    costReference: (parsed as any).costReference,
    usedAt: (parsed as any).usedAt,
    reference: (parsed as any).reference,
    notes: (parsed as any).notes,
    usedByUserId: '', // placeholder
  } as any;
}

function readRequiredUuid(v: unknown, field: string, d: Detail[]): string | undefined {
  if (typeof v !== 'string' || !v.trim()) {
    d.push({ field, message: `${field} is required and must be valid UUID.` });
    return undefined;
  }
  const t = v.trim().toLowerCase();
  if (!isValidUuid(t)) {
    d.push({ field, message: `${field} must be valid UUID.` });
    return undefined;
  }
  return t;
}

function readOptionalUuid(v: unknown, field: string, d: Detail[]): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') {
    d.push({ field, message: `${field} must be valid UUID.` });
    return undefined;
  }
  const t = v.trim().toLowerCase();
  if (!t) return undefined;
  if (!isValidUuid(t)) {
    d.push({ field, message: `${field} must be valid UUID.` });
    return undefined;
  }
  return t;
}

function readPositiveNumber(v: unknown, field: string, d: Detail[]): number | undefined {
  if (v === undefined || v === null || v === '') {
    d.push({ field, message: `${field} is required and must be positive.` });
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    d.push({ field, message: `${field} must be positive number.` });
    return undefined;
  }
  return v;
}

function readOptionalString(v: unknown, field: string, max: number, d: Detail[]): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    d.push({ field, message: `${field} must be string.` });
    return undefined;
  }
  const t = v.trim();
  if (!t) return undefined;
  if (t.length > max) {
    d.push({ field, message: `${field} must be at most ${max} chars.` });
    return undefined;
  }
  return t;
}

function readOptionalDate(v: unknown, field: string, d: Detail[]): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') {
    d.push({ field, message: `${field} must be ISO date string.` });
    return undefined;
  }
  const t = v.trim();
  const date = new Date(t);
  if (isNaN(date.getTime())) {
    d.push({ field, message: `${field} must be valid date.` });
    return undefined;
  }
  return date.toISOString();
}

/** PART 05 — optional non-negative money value (existing decimal convention). */
function readOptionalNonNegativeNumber(
  v: unknown,
  field: string,
  d: Detail[],
): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    d.push({ field, message: `${field} must be a non-negative number.` });
    return undefined;
  }
  return v;
}

/** PART 05 / CUR-02 PART 03 — ISO 4217 format gate; ACTIVE + Client-allowed is the service boundary. */
function readOptionalCurrency(v: unknown, d: Detail[]): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !CURRENCY_PATTERN.test(v.trim().toUpperCase())) {
    d.push({
      field: 'currency',
      message: 'currency must be a three-letter uppercase ISO 4217 code.',
    });
    return undefined;
  }
  return v.trim().toUpperCase();
}
