import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { rfqPoConversionIdempotencyKeyRequiredError } from './rfq-po-conversion.errors';
import type { CreateRfqPoConversionInput } from './rfq-po-conversion.types';

type Detail = { field: string; message: string };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}
function uuid(value: unknown, field: string, details: Detail[]): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}
function text(value: unknown, field: string, max: number, required: boolean, details: Detail[]): string | null | undefined {
  if (value === undefined || value === null) {
    if (required) details.push({ field, message: `${field} is required.` });
    return required ? undefined : value === null ? null : undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string${required ? '' : ' or null'}.` });
    return undefined;
  }
  const result = value.trim();
  if (required && !result) details.push({ field, message: `${field} is required.` });
  if (result.length > max) details.push({ field, message: `${field} must be at most ${max} characters.` });
  return result || null;
}
function idempotency(body: Record<string, unknown>, header: unknown, details: Detail[]): string {
  const raw = typeof header === 'string' && header.trim() ? header.trim() : body.idempotencyKey;
  if (typeof raw !== 'string' || !raw.trim()) throw rfqPoConversionIdempotencyKeyRequiredError();
  const value = raw.trim();
  if (value.length > 200) details.push({ field: 'idempotencyKey', message: 'idempotencyKey must be at most 200 characters.' });
  return value;
}

export function parseCreateRfqPoConversionBody(body: unknown, header: unknown, awardId: string): CreateRfqPoConversionInput {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const poReadinessId = uuid(body.poReadinessId, 'poReadinessId', details);
  const poNumber = text(body.poNumber, 'poNumber', 128, true, details);
  const poDate = text(body.poDate, 'poDate', 10, true, details);
  if (poDate && !/^\d{4}-\d{2}-\d{2}$/.test(poDate)) details.push({ field: 'poDate', message: 'poDate must be an ISO date in YYYY-MM-DD format.' });
  const notes = text(body.notes, 'notes', 2000, false, details);
  const idempotencyKey = idempotency(body, header, details);
  if (details.length || !poReadinessId || !poNumber || !poDate) fail(details);
  return {
    awardId,
    poReadinessId,
    poNumber,
    poDate,
    idempotencyKey,
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseRfqPoConversionIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'conversionId', message: 'conversionId must be a valid UUID.' }]);
  return value;
}
export function parseRfqPoAwardIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'awardId', message: 'awardId must be a valid UUID.' }]);
  return value;
}
export function parsePurchaseOrderIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'purchaseOrderId', message: 'purchaseOrderId must be a valid UUID.' }]);
  return value;
}
