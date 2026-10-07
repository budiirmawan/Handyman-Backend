import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { priceCatalogIdempotencyKeyRequiredError } from './price-catalog-entry.errors';
import {
  isPriceCatalogCurrency,
  isPriceCatalogStatus,
  type CorrectPriceCatalogEntryInput,
  type CreatePriceCatalogEntryInput,
  type PriceCatalogCurrency,
  type PriceCatalogEntryFilters,
  type PriceCatalogSourceMode,
  type ReplacePriceCatalogEntryInput,
  type UpdatePriceCatalogEntryInput,
} from './price-catalog-entry.types';
import type { PriceCatalogLookupInput } from './price-catalog-lookup.types';

export type ValidationDetail = { field: string; message: string };

const MAX_KEY_LENGTH = 200;
const MAX_SOURCE_REFERENCE_LENGTH = 200;
const MAX_NOTES_LENGTH = 1000;
// PART 05 — the override/correction reason is governance evidence: required,
// non-blank after trim, and length-checked (governance §14.1).
const MAX_OVERRIDE_REASON_LENGTH = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function readUuid(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    if (required) details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (value === null && !required) return null;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} must be a valid UUID${required ? '' : ' or null'}.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    details.push({
      field,
      message: `${field} must be at most ${max} characters.`,
    });
    return undefined;
  }
  return trimmed || null;
}

function readCurrency(
  value: unknown,
  required: boolean,
  details: ValidationDetail[],
): PriceCatalogCurrency | undefined {
  if (value === undefined) {
    if (required) {
      details.push({ field: 'currency', message: 'currency is required.' });
    }
    return undefined;
  }
  if (!isPriceCatalogCurrency(value)) {
    details.push({
      field: 'currency',
      message:
        'currency must be one of the supported codes: IDR, USD, SGD, MYR, AUD, EUR, GBP, JPY, CNY.',
    });
    return undefined;
  }
  return value;
}

function readUnitPrice(
  value: unknown,
  required: boolean,
  details: ValidationDetail[],
): number | undefined {
  if (value === undefined) {
    if (required) {
      details.push({ field: 'unitPrice', message: 'unitPrice is required.' });
    }
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    details.push({
      field: 'unitPrice',
      message: 'unitPrice must be a finite number.',
    });
    return undefined;
  }
  if (value <= 0) {
    details.push({
      field: 'unitPrice',
      message: 'unitPrice must be greater than zero.',
    });
    return undefined;
  }
  if (value >= 1e16) {
    details.push({
      field: 'unitPrice',
      message: 'unitPrice exceeds the NUMERIC(18,2) monetary range.',
    });
    return undefined;
  }
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    details.push({
      field: 'unitPrice',
      message: 'unitPrice must have at most two decimal places.',
    });
    return undefined;
  }
  return Math.round(value * 100) / 100;
}

function readIsoTimestamp(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    if (required) details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (value === null && !required) return null;
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    details.push({
      field,
      message: `${field} must be a valid ISO-8601 timestamp${required ? '' : ' or null'}.`,
    });
    return undefined;
  }
  return new Date(value).toISOString();
}

/** Idempotency key from the header/body; required for create and replace. */
function readIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key) throw priceCatalogIdempotencyKeyRequiredError();
  if (key.length > MAX_KEY_LENGTH) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'idempotencyKey',
        message: `idempotencyKey must be at most ${MAX_KEY_LENGTH} characters.`,
      },
    ]);
  }
  return key;
}

export function parsePriceCatalogEntryIdParam(raw: string): string {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  if (!isValidUuid(value)) {
    fail([
      { field: 'id', message: 'Price catalog entry id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreatePriceCatalogEntryBody(
  body: unknown,
  idempotencyKeyHeader: string | undefined,
): CreatePriceCatalogEntryInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  const clientId = readUuid(body.clientId, 'clientId', true, details);
  const buildingId = readUuid(body.buildingId, 'buildingId', false, details);
  const vendorId = readUuid(body.vendorId, 'vendorId', false, details);
  // CR-BE-SVC-01 PART 05 — source mode defaults to MATERIAL (backward-compat
  // with PRICE-01 callers that never sent it). SERVICE requires serviceId and
  // forbids item/UOM; MATERIAL requires item + UOM and forbids serviceId.
  const sourceMode: PriceCatalogSourceMode =
    body.sourceMode === 'SERVICE' ? 'SERVICE' : 'MATERIAL';
  const itemId = readUuid(body.itemId, 'itemId', sourceMode === 'MATERIAL', details);
  const uomId = readUuid(body.uomId, 'uomId', sourceMode === 'MATERIAL', details);
  const serviceId = readUuid(
    body.serviceId,
    'serviceId',
    sourceMode === 'SERVICE',
    details,
  );
  const currency = readCurrency(body.currency, true, details);
  const unitPrice = readUnitPrice(body.unitPrice, true, details);
  const effectiveFrom = readIsoTimestamp(
    body.effectiveFrom,
    'effectiveFrom',
    true,
    details,
  );
  const effectiveTo = readIsoTimestamp(
    body.effectiveTo,
    'effectiveTo',
    false,
    details,
  );
  const sourceReference = readText(
    body.sourceReference,
    'sourceReference',
    MAX_SOURCE_REFERENCE_LENGTH,
    details,
  );
  const notes = readText(body.notes, 'notes', MAX_NOTES_LENGTH, details);
  const approvedByUserId = readUuid(
    body.approvedByUserId,
    'approvedByUserId',
    false,
    details,
  );

  const subjectOk =
    sourceMode === 'MATERIAL'
      ? Boolean(itemId && uomId)
      : Boolean(serviceId);

  if (
    !clientId ||
    !subjectOk ||
    !currency ||
    unitPrice === undefined ||
    !effectiveFrom ||
    details.length > 0
  ) {
    fail(details);
  }

  return {
    clientId,
    buildingId: buildingId ?? null,
    vendorId: vendorId ?? null,
    sourceMode,
    itemId: sourceMode === 'MATERIAL' ? itemId! : undefined,
    uomId: sourceMode === 'MATERIAL' ? uomId! : undefined,
    serviceId: sourceMode === 'SERVICE' ? serviceId! : undefined,
    currency,
    unitPrice,
    effectiveFrom,
    effectiveTo: effectiveTo ?? null,
    sourceReference: sourceReference ?? null,
    notes: notes ?? null,
    approvedByUserId: approvedByUserId ?? null,
    idempotencyKey: readIdempotencyKey(idempotencyKeyHeader),
  };
}

export function parseUpdatePriceCatalogEntryBody(
  body: unknown,
): UpdatePriceCatalogEntryInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  const out: UpdatePriceCatalogEntryInput = {};

  if (body.buildingId !== undefined) {
    const v = readUuid(body.buildingId, 'buildingId', false, details);
    if (v !== undefined) out.buildingId = v;
  }
  if (body.vendorId !== undefined) {
    const v = readUuid(body.vendorId, 'vendorId', false, details);
    if (v !== undefined) out.vendorId = v;
  }
  if (body.itemId !== undefined) {
    const v = readUuid(body.itemId, 'itemId', true, details);
    if (typeof v === 'string') out.itemId = v;
  }
  if (body.uomId !== undefined) {
    const v = readUuid(body.uomId, 'uomId', true, details);
    if (typeof v === 'string') out.uomId = v;
  }
  if (body.currency !== undefined) {
    const v = readCurrency(body.currency, true, details);
    if (v !== undefined) out.currency = v;
  }
  if (body.unitPrice !== undefined) {
    const v = readUnitPrice(body.unitPrice, true, details);
    if (v !== undefined) out.unitPrice = v;
  }
  if (body.effectiveFrom !== undefined) {
    const v = readIsoTimestamp(body.effectiveFrom, 'effectiveFrom', true, details);
    if (v !== undefined && v !== null) out.effectiveFrom = v;
  }
  if (body.effectiveTo !== undefined) {
    const v = readIsoTimestamp(body.effectiveTo, 'effectiveTo', false, details);
    if (v !== undefined) out.effectiveTo = v;
  }
  if (body.sourceReference !== undefined) {
    const v = readText(
      body.sourceReference,
      'sourceReference',
      MAX_SOURCE_REFERENCE_LENGTH,
      details,
    );
    if (v !== undefined) out.sourceReference = v;
  }
  if (body.notes !== undefined) {
    const v = readText(body.notes, 'notes', MAX_NOTES_LENGTH, details);
    if (v !== undefined) out.notes = v;
  }
  if (body.approvedByUserId !== undefined) {
    const v = readUuid(body.approvedByUserId, 'approvedByUserId', false, details);
    if (v !== undefined) out.approvedByUserId = v;
  }

  if (details.length > 0) fail(details);
  if (Object.keys(out).length === 0) {
    fail([{ field: 'body', message: 'At least one field must be provided.' }]);
  }
  return out;
}

export function parseReplacePriceCatalogEntryBody(
  body: unknown,
  idempotencyKeyHeader: string | undefined,
): ReplacePriceCatalogEntryInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  const unitPrice = readUnitPrice(body.unitPrice, true, details);
  const effectiveFrom = readIsoTimestamp(
    body.effectiveFrom,
    'effectiveFrom',
    true,
    details,
  );
  const effectiveTo = readIsoTimestamp(
    body.effectiveTo,
    'effectiveTo',
    false,
    details,
  );
  const sourceReference = readText(
    body.sourceReference,
    'sourceReference',
    MAX_SOURCE_REFERENCE_LENGTH,
    details,
  );
  const notes = readText(body.notes, 'notes', MAX_NOTES_LENGTH, details);
  const approvedByUserId = readUuid(
    body.approvedByUserId,
    'approvedByUserId',
    false,
    details,
  );

  if (unitPrice === undefined || !effectiveFrom || details.length > 0) {
    fail(details);
  }

  return {
    unitPrice,
    effectiveFrom,
    effectiveTo: effectiveTo ?? null,
    sourceReference: sourceReference ?? null,
    notes: notes ?? null,
    approvedByUserId: approvedByUserId ?? null,
    idempotencyKey: readIdempotencyKey(idempotencyKeyHeader),
  };
}

/**
 * PART 05 — governed override/corrective command (`price_catalog.override`,
 * §20). Same facts as a replacement plus the mandatory governance reason:
 * required, non-blank, length-checked (§14.1). Permission enforcement stays
 * at the route boundary; this parser only guarantees well-formed evidence.
 */
export function parseCorrectPriceCatalogEntryBody(
  body: unknown,
  idempotencyKeyHeader: string | undefined,
): CorrectPriceCatalogEntryInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  const unitPrice = readUnitPrice(body.unitPrice, true, details);
  const effectiveFrom = readIsoTimestamp(
    body.effectiveFrom,
    'effectiveFrom',
    true,
    details,
  );
  const effectiveTo = readIsoTimestamp(
    body.effectiveTo,
    'effectiveTo',
    false,
    details,
  );
  const sourceReference = readText(
    body.sourceReference,
    'sourceReference',
    MAX_SOURCE_REFERENCE_LENGTH,
    details,
  );
  const notes = readText(body.notes, 'notes', MAX_NOTES_LENGTH, details);
  const approvedByUserId = readUuid(
    body.approvedByUserId,
    'approvedByUserId',
    false,
    details,
  );
  const reason = readText(
    body.reason,
    'reason',
    MAX_OVERRIDE_REASON_LENGTH,
    details,
  );
  if (body.reason === undefined) {
    details.push({ field: 'reason', message: 'reason is required.' });
  } else if (reason === null) {
    details.push({
      field: 'reason',
      message: 'reason must be a non-empty string.',
    });
  }

  if (!reason || unitPrice === undefined || !effectiveFrom || details.length > 0) {
    fail(details);
  }

  return {
    unitPrice,
    effectiveFrom,
    effectiveTo: effectiveTo ?? null,
    sourceReference: sourceReference ?? null,
    notes: notes ?? null,
    approvedByUserId: approvedByUserId ?? null,
    reason,
    idempotencyKey: readIdempotencyKey(idempotencyKeyHeader),
  };
}
/**
 * PART 02 — resolver probe query (§20): item, building, vendor?, currency,
 * uom, asOf. All timestamps/codes are validated syntactically here; scope
 * and existence checks live in the lookup service.
 */
export function parsePriceCatalogLookupQuery(
  query: unknown,
): PriceCatalogLookupInput {
  if (!isRecord(query)) {
    fail([{ field: 'query', message: 'Lookup query parameters are required.' }]);
  }

  const details: ValidationDetail[] = [];
  const buildingId = readUuid(first(query.buildingId), 'buildingId', true, details);
  // CR-BE-SVC-01 PART 05 — SERVICE lookup uses serviceId (no UOM); MATERIAL
  // uses itemId + uomId. sourceMode defaults to MATERIAL for backward compat.
  const sourceMode: PriceCatalogSourceMode =
    first(query.sourceMode) === 'SERVICE' ? 'SERVICE' : 'MATERIAL';
  const itemId = readUuid(first(query.itemId), 'itemId', sourceMode === 'MATERIAL', details);
  const uomId = readUuid(first(query.uomId), 'uomId', sourceMode === 'MATERIAL', details);
  const serviceId = readUuid(
    first(query.serviceId),
    'serviceId',
    sourceMode === 'SERVICE',
    details,
  );
  const currency = readCurrency(first(query.currency), true, details);
  const asOf = readIsoTimestamp(first(query.asOf), 'asOf', true, details);

  const vendorRaw = first(query.vendorId);
  const vendorId =
    vendorRaw === undefined
      ? undefined
      : readUuid(vendorRaw, 'vendorId', false, details);

  const subjectOk =
    sourceMode === 'MATERIAL' ? Boolean(itemId && uomId) : Boolean(serviceId);

  if (
    !buildingId ||
    !subjectOk ||
    !currency ||
    !asOf ||
    details.length > 0
  ) {
    fail(details);
  }

  return sourceMode === 'MATERIAL'
    ? {
        buildingId,
        vendorId: vendorId ?? null,
        sourceMode: 'MATERIAL',
        itemId: itemId!,
        uomId: uomId!,
        currency,
        asOf,
      }
    : {
        buildingId,
        vendorId: vendorId ?? null,
        sourceMode: 'SERVICE',
        serviceId: serviceId!,
        currency,
        asOf,
      };
}

export function parsePriceCatalogEntryFilters(
  query: unknown,
): PriceCatalogEntryFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const filters: PriceCatalogEntryFilters = {};

  const readOptional = (field: keyof PriceCatalogEntryFilters): void => {
    const raw = first(query[field]);
    if (raw === undefined) return;
    if (field === 'currency') {
      if (!isPriceCatalogCurrency(raw)) {
        details.push({
          field: 'currency',
          message: 'currency must be a supported currency code.',
        });
        return;
      }
      filters.currency = raw;
      return;
    }
    if (field === 'status') {
      if (!isPriceCatalogStatus(raw)) {
        details.push({
          field: 'status',
          message: 'status must be one of: DRAFT, ACTIVE, INACTIVE.',
        });
        return;
      }
      filters.status = raw;
      return;
    }
    if (typeof raw !== 'string' || !isValidUuid(raw.trim())) {
      details.push({ field, message: `${field} must be a valid UUID.` });
      return;
    }
    (filters as Record<string, string>)[field] = raw.trim().toLowerCase();
  };

  readOptional('clientId');
  readOptional('buildingId');
  readOptional('itemId');
  readOptional('serviceId');
  readOptional('vendorId');
  readOptional('uomId');
  readOptional('currency');
  readOptional('status');

  if (details.length > 0) fail(details);
  return filters;
}
