import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  STOCK_MOVEMENT_TYPES,
  isStockMovementType,
  type StockMovementType,
  type CreateStockMovementInput,
} from './inventory-stock-movement.types';

type ValidationDetail = { field: string; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseMovementIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Movement id must be valid UUID.' },
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

export function parseClientIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'Client id must be valid UUID.' },
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

export function parseItemIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'itemId', message: 'Item id must be valid UUID.' },
    ]);
  }
  return v.toLowerCase();
}

export function parseCreateMovementBody(body: unknown): Omit<CreateStockMovementInput, 'performedByUserId' | 'warehouseId'> & { warehouseId?: string } {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Body must be JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const itemId = readRequiredUuid(body.itemId, 'itemId', details);
  const warehouseId = body.warehouseId === undefined ? undefined : readOptionalUuid(body.warehouseId, 'warehouseId', details);
  const movementType = readMovementType(body.movementType, details);
  const quantity = readPositiveNumber(body.quantity, 'quantity', details);
  const movementDate = readOptionalDate(body.movementDate, 'movementDate', details);
  const reference = readOptionalString(body.reference, 'reference', 120, details);
  const source = readOptionalString(body.source, 'source', 120, details);
  const notes = readOptionalString(body.notes, 'notes', 512, details);

  if (!itemId || !movementType || quantity === undefined || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    itemId,
    ...(warehouseId ? { warehouseId } : {}),
    movementType,
    quantity,
    ...(movementDate ? { movementDate } : {}),
    ...(reference ? { reference } : {}),
    ...(source ? { source } : {}),
    ...(notes ? { notes } : {}),
  } as any;
}

export function parseCreateMovementBodyForWarehouse(
  body: unknown,
  pathWarehouseId: string,
): Omit<CreateStockMovementInput, 'performedByUserId' | 'warehouseId'> & { warehouseId: string } {
  const parsed = parseCreateMovementBody(body);
  if (parsed.warehouseId && parsed.warehouseId !== pathWarehouseId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'warehouseId', message: 'Warehouse id in body must match path.' },
    ]);
  }
  return {
    warehouseId: pathWarehouseId,
    itemId: parsed.itemId,
    movementType: parsed.movementType,
    quantity: parsed.quantity,
    movementDate: (parsed as any).movementDate,
    reference: (parsed as any).reference,
    source: (parsed as any).source,
    notes: (parsed as any).notes,
  } as any;
}

function readRequiredUuid(v: unknown, field: string, d: ValidationDetail[]): string | undefined {
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

function readOptionalUuid(v: unknown, field: string, d: ValidationDetail[]): string | undefined {
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

function readMovementType(v: unknown, d: ValidationDetail[]): StockMovementType | undefined {
  if (typeof v !== 'string' || !v.trim()) {
    d.push({ field: 'movementType', message: 'movementType is required.' });
    return undefined;
  }
  const up = v.trim().toUpperCase();
  if (!isStockMovementType(up)) {
    d.push({ field: 'movementType', message: `movementType must be one of: ${STOCK_MOVEMENT_TYPES.join(', ')}.` });
    return undefined;
  }
  return up;
}

function readPositiveNumber(v: unknown, field: string, d: ValidationDetail[]): number | undefined {
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

function readOptionalString(v: unknown, field: string, max: number, d: ValidationDetail[]): string | undefined {
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

function readOptionalDate(v: unknown, field: string, d: ValidationDetail[]): string | undefined {
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
