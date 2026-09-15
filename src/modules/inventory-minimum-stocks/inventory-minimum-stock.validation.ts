import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  MINIMUM_STOCK_STATUSES,
  isMinimumStockStatus,
  type MinimumStockStatus,
  type CreateMinimumStockInput,
  type UpdateMinimumStockInput,
} from './inventory-minimum-stock.types';

type Detail = { field: string; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseMinimumStockIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Minimum stock id must be valid UUID.' },
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

export function parseCreateMinimumStockBody(body: unknown): Omit<CreateMinimumStockInput, 'warehouseId'> & { warehouseId?: string } {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Body must be JSON object.' },
    ]);
  }

  const details: Detail[] = [];

  const warehouseId = body.warehouseId === undefined ? undefined : readOptionalUuid(body.warehouseId, 'warehouseId', details);
  const itemId = readRequiredUuid(body.itemId, 'itemId', details);
  const minimumQuantity = readPositiveNumber(body.minimumQuantity, 'minimumQuantity', details);
  const status = readStatus(body.status, details);

  if (!itemId || minimumQuantity === undefined || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    itemId,
    minimumQuantity,
    ...(warehouseId ? { warehouseId } : {}),
    ...(status ? { status } : {}),
  } as any;
}

export function parseCreateMinimumStockBodyForWarehouse(
  body: unknown,
  pathWarehouseId: string,
): CreateMinimumStockInput {
  const parsed = parseCreateMinimumStockBody(body);
  if ((parsed as any).warehouseId && (parsed as any).warehouseId !== pathWarehouseId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'warehouseId', message: 'Warehouse id in body must match path.' },
    ]);
  }
  return {
    warehouseId: pathWarehouseId,
    itemId: parsed.itemId,
    minimumQuantity: parsed.minimumQuantity,
    status: (parsed as any).status,
  } as any;
}

export function parseUpdateMinimumStockBody(body: unknown): UpdateMinimumStockInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Body must be JSON object.' },
    ]);
  }

  const details: Detail[] = [];

  const minimumQuantity =
    body.minimumQuantity === undefined ? undefined : readPositiveNumber(body.minimumQuantity, 'minimumQuantity', details);
  const status = body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(minimumQuantity === undefined ? {} : { minimumQuantity }),
    ...(status === undefined ? {} : { status }),
  };
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

function readStatus(v: unknown, d: Detail[]): MinimumStockStatus | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (!isMinimumStockStatus(v)) {
    d.push({ field: 'status', message: `status must be one of: ${MINIMUM_STOCK_STATUSES.join(', ')}.` });
    return undefined;
  }
  return v;
}
