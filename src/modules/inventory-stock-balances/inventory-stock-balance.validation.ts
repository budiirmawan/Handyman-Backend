import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { CreateStockBalanceInput } from './inventory-stock-balance.types';

export type ValidationDetail = { field: string; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseStockBalanceIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Stock balance id must be valid UUID.' },
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

export function parseCreateStockBalanceBody(body: unknown): CreateStockBalanceInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Body must be JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  // Accept both itemId mandatory and optional warehouseId (when warehouseId already in path, body warehouseId optional)
  const itemId = readRequiredUuid(body.itemId, 'itemId', details);
  const warehouseId = body.warehouseId === undefined ? undefined : readOptionalUuid(body.warehouseId, 'warehouseId', details);
  const quantityOnHand = readOptionalNonNegativeNumber(body.quantityOnHand, 'quantityOnHand', details);
  const reservedQuantity = readOptionalNonNegativeNumber(body.reservedQuantity, 'reservedQuantity', details);

  if (!itemId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  // Additional check reserved <= on_hand will be done in service and DB constraint, but quick check here
  if (
    quantityOnHand !== undefined &&
    reservedQuantity !== undefined &&
    reservedQuantity > quantityOnHand
  ) {
    details.push({
      field: 'reservedQuantity',
      message: 'Reserved quantity cannot exceed quantity on hand.',
    });
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    warehouseId: warehouseId ?? '',
    itemId,
    ...(quantityOnHand === undefined ? {} : { quantityOnHand }),
    ...(reservedQuantity === undefined ? {} : { reservedQuantity }),
  };
}

export function parseCreateStockBalanceBodyForWarehouse(
  body: unknown,
  pathWarehouseId: string,
): Omit<CreateStockBalanceInput, 'warehouseId'> & { warehouseId: string } {
  const parsed = parseCreateStockBalanceBody(body);
  // If body contained warehouseId it must match path if both provided — for simplicity we enforce path wins and ignore body mismatch? But we check consistency.
  if (parsed.warehouseId && parsed.warehouseId !== '' && parsed.warehouseId !== pathWarehouseId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'warehouseId', message: 'Warehouse id in body must match path.' },
    ]);
  }
  return {
    warehouseId: pathWarehouseId,
    itemId: parsed.itemId,
    quantityOnHand: parsed.quantityOnHand,
    reservedQuantity: parsed.reservedQuantity,
  };
}

function readRequiredUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${field} is required and must be valid UUID.` });
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (!isValidUuid(trimmed)) {
    details.push({ field, message: `${field} must be valid UUID.` });
    return undefined;
  }
  return trimmed;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be valid UUID.` });
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return undefined;
  if (!isValidUuid(trimmed)) {
    details.push({ field, message: `${field} must be valid UUID.` });
    return undefined;
  }
  return trimmed;
}

function readOptionalNonNegativeNumber(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'number') {
    // allow string numeric? Keep strict number.
    details.push({ field, message: `${field} must be a non-negative number.` });
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) {
    details.push({ field, message: `${field} cannot be negative.` });
    return undefined;
  }
  // Round? Keep as is — DB NUMERIC will handle.
  return value;
}
