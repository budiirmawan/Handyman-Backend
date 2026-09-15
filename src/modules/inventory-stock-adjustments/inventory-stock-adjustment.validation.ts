import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ADJUSTMENT_TYPES,
  isAdjustmentType,
  type AdjustmentType,
  type CreateAdjustmentInput,
} from './inventory-stock-adjustment.types';

type ValidationDetail = { field: string; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseAdjustmentIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Adjustment id must be valid UUID.' },
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

export function parseCreateAdjustmentBody(body: unknown): Omit<CreateAdjustmentInput, 'performedByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Body must be JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const warehouseId = body.warehouseId === undefined ? undefined : readOptionalUuid(body.warehouseId, 'warehouseId', details);
  const itemId = readRequiredUuid(body.itemId, 'itemId', details);
  const adjustmentType = readAdjustmentType(body.adjustmentType, details);
  const quantity = readQuantity(body.quantity, 'quantity', adjustmentType, details);
  const reason = readRequiredString(body.reason, 'reason', 512, details);
  const adjustedAt = readOptionalDate(body.adjustedAt, 'adjustedAt', details);
  const reference = readOptionalString(body.reference, 'reference', 120, details);
  const notes = readOptionalString(body.notes, 'notes', 512, details);

  if (!itemId || !adjustmentType || quantity === undefined || !reason || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    warehouseId: warehouseId ?? '',
    itemId,
    adjustmentType,
    quantity,
    reason,
    ...(adjustedAt ? { adjustedAt } : {}),
    ...(reference ? { reference } : {}),
    ...(notes ? { notes } : {}),
  } as any;
}

export function parseCreateAdjustmentBodyForWarehouse(
  body: unknown,
  pathWarehouseId: string,
): Omit<CreateAdjustmentInput, 'performedByUserId'> {
  const parsed = parseCreateAdjustmentBody(body);
  if ((parsed as any).warehouseId && (parsed as any).warehouseId !== '' && (parsed as any).warehouseId !== pathWarehouseId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'warehouseId', message: 'Warehouse id in body must match path.' },
    ]);
  }
  return {
    warehouseId: pathWarehouseId,
    itemId: parsed.itemId,
    adjustmentType: parsed.adjustmentType,
    quantity: parsed.quantity,
    reason: parsed.reason,
    adjustedAt: (parsed as any).adjustedAt,
    reference: (parsed as any).reference,
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

function readAdjustmentType(v: unknown, d: ValidationDetail[]): AdjustmentType | undefined {
  if (typeof v !== 'string' || !v.trim()) {
    d.push({ field: 'adjustmentType', message: 'adjustmentType is required.' });
    return undefined;
  }
  const up = v.trim().toUpperCase();
  if (!isAdjustmentType(up)) {
    d.push({ field: 'adjustmentType', message: `adjustmentType must be one of: ${ADJUSTMENT_TYPES.join(', ')}.` });
    return undefined;
  }
  return up;
}

function readQuantity(v: unknown, field: string, type: AdjustmentType | undefined, d: ValidationDetail[]): number | undefined {
  if (v === undefined || v === null || v === '') {
    d.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    d.push({ field, message: `${field} must be number.` });
    return undefined;
  }
  if (type === 'SET_BALANCE') {
    if (v < 0) {
      d.push({ field, message: `${field} for SET_BALANCE must be >=0.` });
      return undefined;
    }
  } else {
    if (v <= 0) {
      d.push({ field, message: `${field} for INCREASE/DECREASE must be >0.` });
      return undefined;
    }
  }
  return v;
}

function readRequiredString(v: unknown, field: string, max: number, d: ValidationDetail[]): string | undefined {
  if (typeof v !== 'string' || !v.trim()) {
    d.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const t = v.trim();
  if (t.length > max) {
    d.push({ field, message: `${field} must be at most ${max} chars.` });
    return undefined;
  }
  return t;
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
