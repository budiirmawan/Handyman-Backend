import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  TENANT_INVOICE_SOURCE_TYPES, TENANT_INVOICE_STATUSES,
  isTenantInvoiceSourceType, isTenantInvoiceStatus,
  type AddTenantInvoiceLineInput, type CreateTenantInvoiceInput,
  type TenantInvoiceFilters, type TenantInvoiceSourceType,
  type TenantInvoiceStatus, type UpdateTenantInvoiceInput,
} from './tenant-invoice.types';
type Detail = { field: string; message: string };
const NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_\-/]{1,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(details: Detail[]): never { throw AppError.validation('Request validation failed.', details); }
function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field, message: `${field} must be a valid UUID.` }]);
  return value;
}
export const parseTenantInvoiceIdParam = (raw: string): string => parseId(raw, 'tenantInvoiceId');
export const parseTenantInvoiceTenantIdParam = (raw: string): string => parseId(raw, 'tenantCompanyId');
export function parseCreateTenantInvoiceBody(body: unknown): Omit<CreateTenantInvoiceInput, 'tenantCompanyId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const spaceId = readId(body.spaceId, 'spaceId', true, details);
  const invoiceNumber = readNumber(body.invoiceNumber, details);
  const invoiceDate = readDate(body.invoiceDate, 'invoiceDate', true, details);
  const dueDate = readDate(body.dueDate, 'dueDate', true, details);
  const currencyCode = readCurrency(body.currencyCode, details);
  const notes = readString(body.notes, 'notes', 2000, details);
  assertDates(invoiceDate, dueDate, details);
  if (!buildingId || !spaceId || !invoiceNumber || !invoiceDate || !dueDate || !currencyCode || details.length) fail(details);
  return { buildingId, spaceId, invoiceNumber, invoiceDate, dueDate, currencyCode, ...(notes ? { notes } : {}) };
}
export function parseAddTenantInvoiceLineBody(body: unknown): AddTenantInvoiceLineInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const sourceType = readSourceType(body.sourceType, details);
  const sourceId = readId(body.sourceId, 'sourceId', true, details);
  if (!sourceType || !sourceId || details.length) fail(details);
  return { sourceType, sourceId };
}
export function parseUpdateTenantInvoiceBody(body: unknown): UpdateTenantInvoiceInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const immutable = ['clientId','tenantCompanyId','buildingId','spaceId','invoiceNumber','status',
    'subtotal','totalAmount','lines','finalizedAt','cancelledAt'].find((field) => body[field] !== undefined);
  if (immutable) fail([{ field: immutable, message: 'This Invoice field is immutable.' }]);
  const details: Detail[] = [];
  const invoiceDate = body.invoiceDate === undefined ? undefined : readDate(body.invoiceDate, 'invoiceDate', true, details);
  const dueDate = body.dueDate === undefined ? undefined : readDate(body.dueDate, 'dueDate', true, details);
  const notes = body.notes === null ? null : readString(body.notes, 'notes', 2000, details);
  const currencyCode = body.currencyCode === undefined ? undefined : readCurrency(body.currencyCode, details);
  assertDates(invoiceDate, dueDate, details);
  const result: UpdateTenantInvoiceInput = {
    ...(invoiceDate ? { invoiceDate } : {}), ...(dueDate ? { dueDate } : {}),
    ...(currencyCode !== undefined ? { currencyCode } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  if (Object.keys(result).length === 0 && details.length === 0) details.push({ field: 'body', message: 'At least one draft field is required.' });
  if (details.length) fail(details);
  return result;
}
export function parseTenantInvoiceFilters(query: unknown): TenantInvoiceFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const tenantCompanyId = readId(query.tenantCompanyId, 'tenantCompanyId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const status = readStatus(query.status, details);
  const invoiceDateFrom = readDate(query.invoiceDateFrom, 'invoiceDateFrom', false, details);
  const invoiceDateTo = readDate(query.invoiceDateTo, 'invoiceDateTo', false, details);
  if (invoiceDateFrom && invoiceDateTo && invoiceDateTo < invoiceDateFrom) {
    details.push({ field: 'invoiceDateTo', message: 'invoiceDateTo must be the same as or after invoiceDateFrom.' });
  }
  if (details.length) fail(details);
  return {
    ...(tenantCompanyId ? { tenantCompanyId } : {}), ...(buildingId ? { buildingId } : {}),
    ...(status ? { status } : {}), ...(invoiceDateFrom ? { invoiceDateFrom } : {}),
    ...(invoiceDateTo ? { invoiceDateTo } : {}),
  };
}
function readId(value: unknown, field: string, required: boolean, details: Detail[]): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.` }); return undefined;
  }
  return value.trim().toLowerCase();
}
function readNumber(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') { details.push({ field: 'invoiceNumber', message: 'invoiceNumber is required.' }); return undefined; }
  const normalized = value.trim().toUpperCase();
  if (!NUMBER_PATTERN.test(normalized)) { details.push({ field: 'invoiceNumber', message: 'invoiceNumber has an invalid format.' }); return undefined; }
  return normalized;
}
function readDate(value: unknown, field: string, required: boolean, details: Detail[]): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || !isCalendarDate(value)) {
    details.push({ field, message: `${field} ${required ? 'is required and ' : ''}must be a valid YYYY-MM-DD date.` }); return undefined;
  }
  return value;
}
function isCalendarDate(value: string): boolean {
  const [y,m,d] = value.split('-').map(Number); const date = new Date(Date.UTC(y,m-1,d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m-1 && date.getUTCDate() === d;
}
function assertDates(invoiceDate: string | undefined, dueDate: string | undefined, details: Detail[]): void {
  if (invoiceDate && dueDate && dueDate < invoiceDate) details.push({ field: 'dueDate', message: 'dueDate must be the same as or after invoiceDate.' });
}
function readString(value: unknown, field: string, max: number, details: Detail[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) { details.push({ field, message: `${field} must be a non-empty string.` }); return undefined; }
  const result = value.trim(); if (result.length > max) { details.push({ field, message: `${field} must be at most ${max} characters.` }); return undefined; }
  return result;
}
function readCurrency(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value.trim().toUpperCase())) {
    details.push({ field: 'currencyCode', message: 'currencyCode must be a three-letter uppercase currency code.' });
    return undefined;
  }
  return value.trim().toUpperCase();
}
function readSourceType(value: unknown, details: Detail[]): TenantInvoiceSourceType | undefined {
  if (!isTenantInvoiceSourceType(value)) { details.push({ field: 'sourceType', message: `sourceType must be one of: ${TENANT_INVOICE_SOURCE_TYPES.join(', ')}.` }); return undefined; }
  return value;
}
function readStatus(value: unknown, details: Detail[]): TenantInvoiceStatus | undefined {
  if (value === undefined) return undefined;
  if (!isTenantInvoiceStatus(value)) { details.push({ field: 'status', message: `status must be one of: ${TENANT_INVOICE_STATUSES.join(', ')}.` }); return undefined; }
  return value;
}
