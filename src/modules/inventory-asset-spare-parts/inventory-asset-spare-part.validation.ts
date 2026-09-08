import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ASSET_SPARE_PART_STATUSES,
  isAssetSparePartStatus,
  type AssetSparePartStatus,
  type CreateAssetSparePartInput,
  type UpdateAssetSparePartInput,
} from './inventory-asset-spare-part.types';

type Detail = { field: string; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseAssetSparePartIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Binding id must be valid UUID.' },
    ]);
  }
  return v.toLowerCase();
}

export function parseAssetIdParam(raw: string): string {
  const v = raw.trim();
  if (!isValidUuid(v)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'assetId', message: 'Asset id must be valid UUID.' },
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

export function parseCreateAssetSparePartBody(body: unknown): Omit<CreateAssetSparePartInput, 'assetId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Body must be JSON object.' },
    ]);
  }

  const details: Detail[] = [];

  const itemId = readRequiredUuid(body.itemId, 'itemId', details);
  const requiredQuantity = readOptionalPositiveNumber(body.requiredQuantity, 'requiredQuantity', details);
  const status = readStatus(body.status, details);
  const notes = readOptionalString(body.notes, 'notes', 512, details);

  if (!itemId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    itemId,
    ...(requiredQuantity === undefined ? {} : { requiredQuantity }),
    ...(status ? { status } : {}),
    ...(notes ? { notes } : {}),
  } as any;
}

export function parseCreateAssetSparePartBodyForAsset(
  body: unknown,
  pathAssetId: string,
): CreateAssetSparePartInput {
  const parsed = parseCreateAssetSparePartBody(body);
  if ((parsed as any).assetId && (parsed as any).assetId !== pathAssetId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'assetId', message: 'Asset id in body must match path.' },
    ]);
  }
  return {
    assetId: pathAssetId,
    itemId: parsed.itemId,
    requiredQuantity: (parsed as any).requiredQuantity,
    status: (parsed as any).status,
    notes: (parsed as any).notes,
  } as any;
}

export function parseUpdateAssetSparePartBody(body: unknown): UpdateAssetSparePartInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Body must be JSON object.' },
    ]);
  }

  const details: Detail[] = [];

  const requiredQuantity =
    body.requiredQuantity === undefined ? undefined : readOptionalPositiveNumber(body.requiredQuantity, 'requiredQuantity', details);
  const status = body.status === undefined ? undefined : readStatus(body.status, details);
  const notes =
    body.notes === undefined ? undefined : readNullableString(body.notes, 'notes', 512, details);

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

function readStatus(v: unknown, d: Detail[]): AssetSparePartStatus | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (!isAssetSparePartStatus(v)) {
    d.push({ field: 'status', message: `status must be one of: ${ASSET_SPARE_PART_STATUSES.join(', ')}.` });
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
