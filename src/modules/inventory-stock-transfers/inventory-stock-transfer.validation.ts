import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { CreateTransferInput } from './inventory-stock-transfer.types';

type ValidationDetail = { field: string; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseTransferIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Transfer id must be valid UUID.' },
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

export function parseCreateTransferBody(body: unknown): Omit<CreateTransferInput, 'performedByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Body must be JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const sourceWarehouseId = readRequiredUuid(body.sourceWarehouseId, 'sourceWarehouseId', details);
  const destinationWarehouseId = readRequiredUuid(body.destinationWarehouseId, 'destinationWarehouseId', details);
  const itemId = readRequiredUuid(body.itemId, 'itemId', details);
  const quantity = readPositiveNumber(body.quantity, 'quantity', details);
  const transferDate = readOptionalDate(body.transferDate, 'transferDate', details);
  const reference = readOptionalString(body.reference, 'reference', 120, details);
  const notes = readOptionalString(body.notes, 'notes', 512, details);

  if (details.length > 0 || !sourceWarehouseId || !destinationWarehouseId || !itemId || quantity === undefined) {
    throw AppError.validation('Request validation failed.', details);
  }

  if (sourceWarehouseId === destinationWarehouseId) {
    details.push({ field: 'destinationWarehouseId', message: 'Source and destination must be different.' });
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    sourceWarehouseId,
    destinationWarehouseId,
    itemId,
    quantity,
    ...(transferDate ? { transferDate } : {}),
    ...(reference ? { reference } : {}),
    ...(notes ? { notes } : {}),
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
