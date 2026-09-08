import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  TENANT_CHARGE_STATUSES,
  isTenantChargeStatus,
  type CreateTenantChargeInput,
  type TenantChargeFilters,
  type TenantChargeStatus,
  type UpdateTenantChargeInput,
} from './tenant-charge.types';

type Detail = { field: string; message: string };
const TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}
function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field, message: `${field} must be a valid UUID.` }]);
  return value;
}
export const parseTenantChargeIdParam = (raw: string): string => parseId(raw, 'tenantChargeId');
export const parseTenantChargeCompanyIdParam = (raw: string): string => parseId(raw, 'tenantCompanyId');

export function parseCreateTenantChargeBody(
  body: unknown,
): Omit<CreateTenantChargeInput, 'tenantCompanyId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const spaceId = readId(body.spaceId, 'spaceId', true, details);
  const chargeType = readChargeType(body.chargeType, true, details);
  const description = readString(body.description, 'description', 500, true, details);
  const amount = readAmount(body.amount, true, details);
  const currencyCode = readCurrency(body.currencyCode, details);
  const chargeDate = readDate(body.chargeDate, 'chargeDate', true, details);
  const dueDate = readNullableDate(body.dueDate, 'dueDate', details);
  const reference = readString(body.reference, 'reference', 255, false, details);
  const notes = readString(body.notes, 'notes', 2000, false, details);
  assertDateOrder(chargeDate, dueDate, details);
  if (!buildingId || !spaceId || !chargeType || !description || amount === undefined || !currencyCode || !chargeDate || details.length) fail(details);
  return {
    buildingId, spaceId, chargeType, description, amount, currencyCode, chargeDate,
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(reference ? { reference } : {}),
    ...(notes ? { notes } : {}),
  };
}

export function parseUpdateTenantChargeBody(body: unknown): UpdateTenantChargeInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const immutable = [
    'clientId', 'tenantCompanyId', 'buildingId', 'spaceId', 'status',
    'createdByUserId', 'cancelledAt', 'cancelledByUserId',
  ].find((field) => body[field] !== undefined);
  if (immutable) fail([{ field: immutable, message: 'This field is immutable and cannot be updated.' }]);
  const details: Detail[] = [];
  const chargeType = body.chargeType === undefined ? undefined : readChargeType(body.chargeType, true, details);
  const description = body.description === undefined ? undefined : readString(body.description, 'description', 500, true, details);
  const amount = body.amount === undefined ? undefined : readAmount(body.amount, true, details);
  const currencyCode = body.currencyCode === undefined ? undefined : readCurrency(body.currencyCode, details);
  const chargeDate = body.chargeDate === undefined ? undefined : readDate(body.chargeDate, 'chargeDate', true, details);
  const dueDate = readNullableDate(body.dueDate, 'dueDate', details);
  const reference = body.reference === null ? null : readString(body.reference, 'reference', 255, false, details);
  const notes = body.notes === null ? null : readString(body.notes, 'notes', 2000, false, details);
  assertDateOrder(chargeDate, dueDate, details);
  if (details.length) fail(details);
  return {
    ...(chargeType !== undefined ? { chargeType } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(currencyCode !== undefined ? { currencyCode } : {}),
    ...(chargeDate !== undefined ? { chargeDate } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(reference !== undefined ? { reference } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseTenantChargeFilters(query: unknown): TenantChargeFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const tenantCompanyId = readId(query.tenantCompanyId, 'tenantCompanyId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const spaceId = readId(query.spaceId, 'spaceId', false, details);
  const chargeType = query.chargeType === undefined ? undefined : readChargeType(query.chargeType, true, details);
  const status = readStatus(query.status, details);
  const chargeDateFrom = readDate(query.chargeDateFrom, 'chargeDateFrom', false, details);
  const chargeDateTo = readDate(query.chargeDateTo, 'chargeDateTo', false, details);
  if (chargeDateFrom && chargeDateTo && chargeDateTo < chargeDateFrom) {
    details.push({ field: 'chargeDateTo', message: 'chargeDateTo must be the same as or after chargeDateFrom.' });
  }
  if (details.length) fail(details);
  return {
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(chargeType ? { chargeType } : {}),
    ...(status ? { status } : {}),
    ...(chargeDateFrom ? { chargeDateFrom } : {}),
    ...(chargeDateTo ? { chargeDateTo } : {}),
  };
}

export function parseCancelTenantChargeBody(body: unknown): string | null {
  if (body === undefined || body === null || (isRecord(body) && Object.keys(body).length === 0)) return null;
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const notes = readString(body.notes, 'notes', 2000, false, details);
  if (details.length) fail(details);
  return notes ?? null;
}

function readId(value: unknown, field: string, required: boolean, details: Detail[]): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}
function readChargeType(value: unknown, required: boolean, details: Detail[]): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') {
    details.push({ field: 'chargeType', message: 'chargeType is required.' });
    return undefined;
  }
  const result = value.trim().toUpperCase();
  if (!TYPE_PATTERN.test(result)) {
    details.push({ field: 'chargeType', message: 'chargeType must be a valid data-driven code.' });
    return undefined;
  }
  return result;
}
function readString(value: unknown, field: string, max: number, required: boolean, details: Detail[]): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: required ? `${field} is required.` : `${field} must be a non-empty string.` });
    return undefined;
  }
  const result = value.trim();
  if (result.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return result;
}
function readCurrency(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value.trim().toUpperCase())) {
    details.push({ field: 'currencyCode', message: 'currencyCode must be a three-letter uppercase currency code.' });
    return undefined;
  }
  return value.trim().toUpperCase();
}
function readAmount(value: unknown, required: boolean, details: Detail[]): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 999_999_999_999.99) {
    details.push({ field: 'amount', message: 'amount must be a finite, non-negative number within the supported range.' });
    return undefined;
  }
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) {
    details.push({ field: 'amount', message: 'amount must have at most two decimal places.' });
    return undefined;
  }
  return value;
}
function readDate(value: unknown, field: string, required: boolean, details: Detail[]): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || !isCalendarDate(value)) {
    details.push({ field, message: `${field} ${required ? 'is required and ' : ''}must be a valid YYYY-MM-DD date.` });
    return undefined;
  }
  return value;
}
function readNullableDate(value: unknown, field: string, details: Detail[]): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readDate(value, field, true, details);
}
function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function assertDateOrder(chargeDate: string | undefined, dueDate: string | null | undefined, details: Detail[]): void {
  if (chargeDate && dueDate && dueDate < chargeDate) {
    details.push({ field: 'dueDate', message: 'dueDate must be the same as or after chargeDate.' });
  }
}
function readStatus(value: unknown, details: Detail[]): TenantChargeStatus | undefined {
  if (value === undefined) return undefined;
  if (!isTenantChargeStatus(value)) {
    details.push({ field: 'status', message: `status must be one of: ${TENANT_CHARGE_STATUSES.join(', ')}.` });
    return undefined;
  }
  return value;
}
