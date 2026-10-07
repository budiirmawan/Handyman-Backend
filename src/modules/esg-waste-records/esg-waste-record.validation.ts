import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ESG_DISPOSAL_METHODS,
  ESG_WASTE_SOURCE_TYPES,
  ESG_WASTE_TYPES,
  isEsgDisposalMethod,
  isEsgWasteSourceType,
  isEsgWasteStatus,
  isEsgWasteType,
  type CreateEsgWasteRecordInput,
  type EsgWasteRecordFilters,
  type UpdateEsgWasteRecordInput,
} from './esg-waste-record.types';

type Detail = { field: string; message: string };

const MAX_NOTES = 2000;
const MAX_SEARCH = 200;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

function readRequiredUuid(v: unknown, field: string, details: Detail[]): string | undefined {
  if (typeof v !== 'string' || !isValidUuid(v.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return v.trim().toLowerCase();
}

function readOptionalUuid(v: unknown, field: string, details: Detail[]): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string' || !isValidUuid(v.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return v.trim().toLowerCase();
}

function readOptionalText(v: unknown, field: string, max: number, details: Detail[]): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = v.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return trimmed;
}

function readNullableText(v: unknown, field: string, max: number, details: Detail[]): string | null | undefined {
  if (v === null) return null;
  return readOptionalText(v, field, max, details);
}

function readQuantity(v: unknown, details: Detail[]): number | undefined {
  if (v === undefined || v === null) {
    details.push({ field: 'quantity', message: 'quantity is required.' });
    return undefined;
  }
  const num = typeof v === 'string' ? Number(v) : v;
  if (typeof num !== 'number' || Number.isNaN(num) || !Number.isFinite(num)) {
    details.push({ field: 'quantity', message: 'quantity must be a number.' });
    return undefined;
  }
  if (num < 0) {
    details.push({ field: 'quantity', message: 'quantity must be >= 0.' });
    return undefined;
  }
  return num;
}

function readOptionalQuantity(v: unknown, details: Detail[]): number | undefined {
  if (v === undefined) return undefined;
  if (v === null) {
    details.push({ field: 'quantity', message: 'quantity must be a number.' });
    return undefined;
  }
  const num = typeof v === 'string' ? Number(v) : v;
  if (typeof num !== 'number' || Number.isNaN(num) || !Number.isFinite(num)) {
    details.push({ field: 'quantity', message: 'quantity must be a number.' });
    return undefined;
  }
  if (num < 0) {
    details.push({ field: 'quantity', message: 'quantity must be >= 0.' });
    return undefined;
  }
  return num;
}

function readDate(v: unknown, field: string, details: Detail[]): string | undefined {
  if (typeof v !== 'string') {
    details.push({ field, message: `${field} must be YYYY-MM-DD.` });
    return undefined;
  }
  const trimmed = v.trim();
  if (!DATE_REGEX.test(trimmed)) {
    details.push({ field, message: `${field} must be YYYY-MM-DD.` });
    return undefined;
  }
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    details.push({ field, message: `${field} must be a valid date.` });
    return undefined;
  }
  return trimmed;
}

function readOptionalDate(v: unknown, field: string, details: Detail[]): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return readDate(v, field, details);
}

export function parseEsgWasteRecordIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'ESG waste record id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateEsgWasteRecordBody(body: unknown): CreateEsgWasteRecordInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: Detail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const functionalLocationId = readOptionalUuid(body.functionalLocationId, 'functionalLocationId', details);
  const uomId = readRequiredUuid(body.uomId, 'uomId', details);
  const vendorId = readOptionalUuid(body.vendorId, 'vendorId', details);

  let wasteType: CreateEsgWasteRecordInput['wasteType'] | undefined;
  if (typeof body.wasteType !== 'string' || !isEsgWasteType(body.wasteType)) {
    details.push({
      field: 'wasteType',
      message: `wasteType must be one of: ${ESG_WASTE_TYPES.join(', ')}.`,
    });
  } else {
    wasteType = body.wasteType;
  }

  let disposalMethod: CreateEsgWasteRecordInput['disposalMethod'] | undefined;
  if (typeof body.disposalMethod !== 'string' || !isEsgDisposalMethod(body.disposalMethod)) {
    details.push({
      field: 'disposalMethod',
      message: `disposalMethod must be one of: ${ESG_DISPOSAL_METHODS.join(', ')}.`,
    });
  } else {
    disposalMethod = body.disposalMethod;
  }

  const quantity = readQuantity(body.quantity, details);
  const periodDate = readDate(body.periodDate, 'periodDate', details);

  let sourceType: CreateEsgWasteRecordInput['sourceType'] | undefined;
  if (body.sourceType !== undefined) {
    if (typeof body.sourceType !== 'string' || !isEsgWasteSourceType(body.sourceType)) {
      details.push({
        field: 'sourceType',
        message: `sourceType must be one of: ${ESG_WASTE_SOURCE_TYPES.join(', ')}.`,
      });
    } else {
      sourceType = body.sourceType;
    }
  }

  const notes = readNullableText(body.notes, 'notes', MAX_NOTES, details);

  if (!buildingId || !wasteType || !disposalMethod || quantity === undefined || !uomId || !periodDate || details.length > 0) {
    fail(details);
  }

  return {
    buildingId: buildingId!,
    wasteType: wasteType!,
    disposalMethod: disposalMethod!,
    quantity: quantity!,
    uomId: uomId!,
    periodDate: periodDate!,
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseUpdateEsgWasteRecordBody(body: unknown): UpdateEsgWasteRecordInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: Detail[] = [];

  if (body.buildingId !== undefined) {
    details.push({ field: 'buildingId', message: 'buildingId is immutable.' });
  }
  if (body.status !== undefined) {
    details.push({
      field: 'status',
      message: 'status is not editable via PATCH; use deactivate endpoint.',
    });
  }

  const functionalLocationId = readOptionalUuid(body.functionalLocationId, 'functionalLocationId', details);
  const uomId = body.uomId === undefined ? undefined : readRequiredUuid(body.uomId, 'uomId', details);
  const vendorId = readOptionalUuid(body.vendorId, 'vendorId', details);
  const quantity = readOptionalQuantity(body.quantity, details);
  const periodDate = body.periodDate === undefined ? undefined : readDate(body.periodDate, 'periodDate', details);

  let wasteType: UpdateEsgWasteRecordInput['wasteType'] | undefined;
  if (body.wasteType !== undefined) {
    if (typeof body.wasteType !== 'string' || !isEsgWasteType(body.wasteType)) {
      details.push({
        field: 'wasteType',
        message: `wasteType must be one of: ${ESG_WASTE_TYPES.join(', ')}.`,
      });
    } else {
      wasteType = body.wasteType;
    }
  }

  let disposalMethod: UpdateEsgWasteRecordInput['disposalMethod'] | undefined;
  if (body.disposalMethod !== undefined) {
    if (typeof body.disposalMethod !== 'string' || !isEsgDisposalMethod(body.disposalMethod)) {
      details.push({
        field: 'disposalMethod',
        message: `disposalMethod must be one of: ${ESG_DISPOSAL_METHODS.join(', ')}.`,
      });
    } else {
      disposalMethod = body.disposalMethod;
    }
  }

  let sourceType: UpdateEsgWasteRecordInput['sourceType'] | undefined;
  if (body.sourceType !== undefined) {
    if (typeof body.sourceType !== 'string' || !isEsgWasteSourceType(body.sourceType)) {
      details.push({
        field: 'sourceType',
        message: `sourceType must be one of: ${ESG_WASTE_SOURCE_TYPES.join(', ')}.`,
      });
    } else {
      sourceType = body.sourceType;
    }
  }

  const notes = readNullableText(body.notes, 'notes', MAX_NOTES, details);

  if (details.length > 0) fail(details);

  return {
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(uomId === undefined ? {} : { uomId }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(quantity === undefined ? {} : { quantity }),
    ...(periodDate === undefined ? {} : { periodDate }),
    ...(wasteType === undefined ? {} : { wasteType }),
    ...(disposalMethod === undefined ? {} : { disposalMethod }),
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseEsgWasteRecordFilters(query: unknown): EsgWasteRecordFilters {
  if (!isRecord(query)) return {};

  const details: Detail[] = [];
  const filters: EsgWasteRecordFilters = {};

  const readFilterUuid = (key: string) => {
    const raw = first((query as Record<string, unknown>)[key]);
    if (raw === undefined || raw === '') return undefined;
    return readRequiredUuid(raw, key, details);
  };

  const clientId = readFilterUuid('clientId');
  if (clientId) filters.clientId = clientId;
  const buildingId = readFilterUuid('buildingId');
  if (buildingId) filters.buildingId = buildingId;
  const flocId = readFilterUuid('functionalLocationId');
  if (flocId) filters.functionalLocationId = flocId;
  const uomId = readFilterUuid('uomId');
  if (uomId) filters.uomId = uomId;
  const vendorId = readFilterUuid('vendorId');
  if (vendorId) filters.vendorId = vendorId;

  const wasteTypeRaw = first((query as Record<string, unknown>).wasteType);
  if (wasteTypeRaw !== undefined && wasteTypeRaw !== '') {
    if (isEsgWasteType(wasteTypeRaw)) filters.wasteType = wasteTypeRaw;
    else details.push({ field: 'wasteType', message: `wasteType must be one of: ${ESG_WASTE_TYPES.join(', ')}.` });
  }

  const disposalRaw = first((query as Record<string, unknown>).disposalMethod);
  if (disposalRaw !== undefined && disposalRaw !== '') {
    if (isEsgDisposalMethod(disposalRaw)) filters.disposalMethod = disposalRaw;
    else details.push({ field: 'disposalMethod', message: `disposalMethod must be one of: ${ESG_DISPOSAL_METHODS.join(', ')}.` });
  }

  const sourceRaw = first((query as Record<string, unknown>).sourceType);
  if (sourceRaw !== undefined && sourceRaw !== '') {
    if (isEsgWasteSourceType(sourceRaw)) filters.sourceType = sourceRaw;
    else details.push({ field: 'sourceType', message: `sourceType must be one of: ${ESG_WASTE_SOURCE_TYPES.join(', ')}.` });
  }

  const statusRaw = first((query as Record<string, unknown>).status);
  if (statusRaw !== undefined && statusRaw !== '') {
    if (isEsgWasteStatus(statusRaw)) filters.status = statusRaw;
    else details.push({ field: 'status', message: 'status must be one of: ACTIVE, INACTIVE.' });
  }

  const dateFromRaw = first((query as Record<string, unknown>).dateFrom);
  if (dateFromRaw !== undefined && dateFromRaw !== '') {
    const d = readOptionalDate(dateFromRaw, 'dateFrom', details);
    if (d) filters.dateFrom = d;
  }
  const dateToRaw = first((query as Record<string, unknown>).dateTo);
  if (dateToRaw !== undefined && dateToRaw !== '') {
    const d = readOptionalDate(dateToRaw, 'dateTo', details);
    if (d) filters.dateTo = d;
  }

  const searchRaw = first((query as Record<string, unknown>).search);
  if (searchRaw !== undefined && searchRaw !== '') {
    const s = readOptionalText(searchRaw, 'search', MAX_SEARCH, details);
    if (s) filters.search = s;
  }

  if (details.length > 0) fail(details);
  return filters;
}
