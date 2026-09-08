import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isRfqCurrency,
  isRfqSourceMode,
  isRfqStatus,
  RFQ_CURRENCIES,
  RFQ_SOURCE_MODES,
  RFQ_STATUSES,
  type CreateRfqInput,
  type CreateRfqLineInput,
  type RfqCurrency,
  type RfqFilters,
  type RfqLineSourceType,
  type RfqSourceMode,
  type RfqStatus,
  type UpdateRfqInput,
} from './rfq.types';
import { rfqIdempotencyKeyRequiredError } from './rfq.errors';

export type ValidationDetail = { field: string; message: string };

const NUMBER_PATTERN = /^[A-Z][A-Z0-9_-]{1,63}$/;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_TITLE_LENGTH = 200;
const MAX_KEY_LENGTH = 200;

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
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readText(
  value: unknown,
  field: string,
  max: number,
  required: boolean,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    if (required) details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (value === null && !required) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string${required ? '' : ' or null'}.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed && required) {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (trimmed.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return trimmed || (required ? undefined : null);
}

function readCode(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!NUMBER_PATTERN.test(normalized)) {
    details.push({
      field,
      message: `${field} must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).`,
    });
    return undefined;
  }
  return normalized;
}

function readDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    details.push({ field, message: `${field} must be a valid ISO date-time string or null.` });
    return undefined;
  }
  return value;
}

function readSourceMode(value: unknown, details: ValidationDetail[]): RfqSourceMode | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'sourceMode', message: 'sourceMode is required.' });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!isRfqSourceMode(normalized)) {
    details.push({
      field: 'sourceMode',
      message: `sourceMode must be one of: ${RFQ_SOURCE_MODES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readCurrency(value: unknown, details: ValidationDetail[]): RfqCurrency | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'currency', message: 'currency is required.' });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!isRfqCurrency(normalized)) {
    details.push({
      field: 'currency',
      message: `currency must be one of: ${RFQ_CURRENCIES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readKey(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const key = value.trim();
  if (key.length > MAX_KEY_LENGTH) {
    details.push({ field: 'idempotencyKey', message: `idempotencyKey must be at most ${MAX_KEY_LENGTH} characters.` });
    return undefined;
  }
  return key;
}

function readStatus(value: unknown, details: ValidationDetail[]): RfqStatus | undefined {
  if (value === undefined) return undefined;
  const candidate = typeof value === 'string' ? value.trim().toUpperCase() : value;
  if (!isRfqStatus(candidate)) {
    details.push({ field: 'status', message: `status must be one of: ${RFQ_STATUSES.join(', ')}.` });
    return undefined;
  }
  return candidate;
}

export function parseRfqIdParam(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!isValidUuid(id)) fail([{ field: 'id', message: 'id must be a valid UUID.' }]);
  return id;
}

export function parseRfqLineIdParam(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!isValidUuid(id)) fail([{ field: 'lineId', message: 'lineId must be a valid UUID.' }]);
  return id;
}

export function parseCreateRfqBody(
  body: unknown,
  headerIdempotencyKey?: unknown,
): CreateRfqInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: ValidationDetail[] = [];
  const purchaseRequestId = readUuid(body.purchaseRequestId, 'purchaseRequestId', true, details);
  const sourceMode = readSourceMode(body.sourceMode ?? body.sourceType, details);
  const rfqNumber = readCode(body.rfqNumber, 'rfqNumber', details);
  const title = readText(body.title, 'title', MAX_TITLE_LENGTH, true, details);
  const description = readText(body.description, 'description', MAX_DESCRIPTION_LENGTH, false, details);
  const currency = readCurrency(body.currency, details);
  const requiredDate = readDate(body.requiredDate, 'requiredDate', details);
  const responseDeadline = readDate(body.responseDeadline, 'responseDeadline', details);
  const clientId = readUuid(body.clientId, 'clientId', false, details);
  const buildingId = readUuid(body.buildingId, 'buildingId', false, details);
  const idempotencyKey = readKey(
    typeof headerIdempotencyKey === 'string' && headerIdempotencyKey.trim()
      ? headerIdempotencyKey
      : body.idempotencyKey,
    details,
  );

  if (!idempotencyKey) {
    // Keep the stable domain error distinct from ordinary body validation so
    // clients can safely repair missing idempotency without retry ambiguity.
    throw rfqIdempotencyKeyRequiredError();
  }
  if (!purchaseRequestId || !sourceMode || !rfqNumber || !title || !currency || details.length) {
    fail(details);
  }
  return {
    purchaseRequestId,
    sourceMode,
    rfqNumber,
    title,
    currency,
    idempotencyKey,
    ...(description !== undefined ? { description } : {}),
    ...(requiredDate !== undefined ? { requiredDate } : {}),
    ...(responseDeadline !== undefined ? { responseDeadline } : {}),
    ...(clientId ? { clientId } : {}),
    ...(buildingId ? { buildingId } : {}),
  };
}

export function parseUpdateRfqBody(body: unknown): UpdateRfqInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: ValidationDetail[] = [];
  const title = body.title === undefined ? undefined : readText(body.title, 'title', MAX_TITLE_LENGTH, true, details);
  const description = body.description === undefined ? undefined : readText(body.description, 'description', MAX_DESCRIPTION_LENGTH, false, details);
  const currency = body.currency === undefined ? undefined : readCurrency(body.currency, details);
  const requiredDate = readDate(body.requiredDate, 'requiredDate', details);
  const responseDeadline = readDate(body.responseDeadline, 'responseDeadline', details);
  if (details.length) fail(details);
  return {
    ...(title === undefined ? {} : { title: title as string }),
    ...(description === undefined ? {} : { description }),
    ...(currency === undefined ? {} : { currency }),
    ...(requiredDate === undefined ? {} : { requiredDate }),
    ...(responseDeadline === undefined ? {} : { responseDeadline }),
  };
}

export function parseCreateRfqLineBody(body: unknown): CreateRfqLineInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: ValidationDetail[] = [];
  const materialRequestId = readUuid(body.materialRequestId, 'materialRequestId', false, details);
  const serviceRequestId = readUuid(body.serviceRequestId, 'serviceRequestId', false, details);
  const rawType = body.sourceLineType ?? body.requestLineType ?? body.lineType ?? body.sourceType;
  const rawId = body.sourceLineId ?? body.requestLineId ?? body.lineId ?? body.sourceId;

  let sourceLineType: RfqLineSourceType | undefined;
  if (rawType !== undefined) {
    if (typeof rawType !== 'string') {
      details.push({ field: 'sourceLineType', message: 'sourceLineType must be MATERIAL_REQUEST or SERVICE_REQUEST.' });
    } else {
      const normalized = rawType.trim().toUpperCase();
      if (normalized === 'MATERIAL' || normalized === 'MATERIAL_REQUEST') sourceLineType = 'MATERIAL_REQUEST';
      else if (normalized === 'SERVICE' || normalized === 'SERVICE_REQUEST') sourceLineType = 'SERVICE_REQUEST';
      else details.push({ field: 'sourceLineType', message: 'sourceLineType must be MATERIAL_REQUEST or SERVICE_REQUEST.' });
    }
  }

  if (materialRequestId && serviceRequestId) {
    details.push({ field: 'sourceLine', message: 'Only one typed demand-line reference may be supplied.' });
  }
  if (!sourceLineType) {
    sourceLineType = materialRequestId ? 'MATERIAL_REQUEST' : serviceRequestId ? 'SERVICE_REQUEST' : undefined;
  }
  if (sourceLineType && rawId !== undefined && (materialRequestId || serviceRequestId)) {
    const typedId = sourceLineType === 'MATERIAL_REQUEST' ? materialRequestId : serviceRequestId;
    if (typedId && rawId !== typedId) {
      details.push({ field: 'sourceLineId', message: 'sourceLineId conflicts with the typed demand-line reference.' });
    }
  }

  const sourceLineId = rawId === undefined
    ? (sourceLineType === 'MATERIAL_REQUEST' ? materialRequestId : serviceRequestId)
    : readUuid(rawId, 'sourceLineId', true, details);

  if (!sourceLineType) details.push({ field: 'sourceLineType', message: 'sourceLineType is required.' });
  if (!sourceLineId) details.push({ field: 'sourceLineId', message: 'sourceLineId is required and must be a valid UUID.' });
  if (details.length) fail(details);
  return { sourceLineType: sourceLineType!, sourceLineId: sourceLineId! };
}

export function parseRfqFilters(query: unknown): RfqFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const sourceMode = query.sourceMode === undefined ? undefined : readSourceMode(query.sourceMode, details);
  const status = readStatus(query.status, details);
  const buildingId = query.buildingId === undefined ? undefined : readUuid(first(query.buildingId), 'buildingId', true, details);
  const purchaseRequestId = query.purchaseRequestId === undefined ? undefined : readUuid(first(query.purchaseRequestId), 'purchaseRequestId', true, details);
  if (details.length) fail(details);
  return {
    ...(sourceMode === undefined ? {} : { sourceMode }),
    ...(status === undefined ? {} : { status }),
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(purchaseRequestId === undefined ? {} : { purchaseRequestId }),
  };
}

export function parseRfqStatusParam(raw: string): RfqStatus {
  const status = raw.trim().toUpperCase();
  if (!isRfqStatus(status)) fail([{ field: 'status', message: `status must be one of: ${RFQ_STATUSES.join(', ')}.` }]);
  return status;
}
