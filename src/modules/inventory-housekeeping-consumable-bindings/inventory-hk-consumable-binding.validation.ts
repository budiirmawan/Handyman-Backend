import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HK_BINDING_STATUSES,
  isHkBindingStatus,
  type HkBindingStatus,
  type CreateHkBindingInput,
  type UpdateHkBindingInput,
} from './inventory-hk-consumable-binding.types';

type Detail = { field: string; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseBindingIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Binding id must be valid UUID.' },
    ]);
  }
  return v.toLowerCase();
}

export function parseRequirementIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'requirementId', message: 'Requirement id must be valid UUID.' },
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

export function parseBuildingIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be valid UUID.' },
    ]);
  }
  return v.toLowerCase();
}

export function parseCleaningAreaIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'cleaningAreaId', message: 'Cleaning area id must be valid UUID.' },
    ]);
  }
  return v.toLowerCase();
}

export function parseCreateBindingBody(body: unknown): Omit<CreateHkBindingInput, 'consumableRequirementId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Body must be JSON object.' },
    ]);
  }

  const details: Detail[] = [];

  const itemId = readRequiredUuid(body.itemId, 'itemId', details);
  const warehouseId = readRequiredUuid(body.warehouseId, 'warehouseId', details);
  const requiredQuantity = readOptionalPositiveNumber(body.requiredQuantity, 'requiredQuantity', details);
  const status = readStatus(body.status, details);
  const notes = readOptionalString(body.notes, 'notes', 512, details);

  if (!itemId || !warehouseId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    itemId,
    warehouseId,
    ...(requiredQuantity === undefined ? {} : { requiredQuantity }),
    ...(status ? { status } : {}),
    ...(notes ? { notes } : {}),
  } as any;
}

export function parseCreateBindingBodyForRequirement(
  body: unknown,
  pathRequirementId: string,
): CreateHkBindingInput {
  const parsed = parseCreateBindingBody(body);
  if ((parsed as any).consumableRequirementId && (parsed as any).consumableRequirementId !== pathRequirementId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'consumableRequirementId', message: 'Requirement id in body must match path.' },
    ]);
  }
  return {
    consumableRequirementId: pathRequirementId,
    itemId: parsed.itemId,
    warehouseId: parsed.warehouseId,
    requiredQuantity: (parsed as any).requiredQuantity,
    status: (parsed as any).status,
    notes: (parsed as any).notes,
  } as any;
}

export function parseUpdateBindingBody(body: unknown): UpdateHkBindingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Body must be JSON object.' },
    ]);
  }

  const details: Detail[] = [];

  const requiredQuantity =
    body.requiredQuantity === undefined ? undefined : readOptionalPositiveNumber(body.requiredQuantity, 'requiredQuantity', details);
  const status = body.status === undefined ? undefined : readStatus(body.status, details);
  const notes = body.notes === undefined ? undefined : readNullableString(body.notes, 'notes', 512, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(requiredQuantity === undefined ? {} : { requiredQuantity }),
    ...(status === undefined ? {} : { status }),
    ...(notes === undefined ? {} : { notes }),
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

function readOptionalPositiveNumber(v: unknown, field: string, d: Detail[]): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    d.push({ field, message: `${field} must be positive number.` });
    return undefined;
  }
  return v;
}

function readStatus(v: unknown, d: Detail[]): HkBindingStatus | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (!isHkBindingStatus(v)) {
    d.push({ field: 'status', message: `status must be one of: ${HK_BINDING_STATUSES.join(', ')}.` });
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

function readNullableString(v: unknown, field: string, max: number, d: Detail[]): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') {
    d.push({ field, message: `${field} must be string or null.` });
    return undefined;
  }
  const t = v.trim();
  if (!t) return null;
  if (t.length > max) {
    d.push({ field, message: `${field} must be at most ${max} chars.` });
    return undefined;
  }
  return t;
}
