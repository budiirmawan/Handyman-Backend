import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  UTILITY_BILL_STATUSES,
  UTILITY_BILL_TYPES,
  isUtilityBillStatus,
  isUtilityBillType,
  type GenerateUtilityBillInput,
  type UtilityBillFilters,
  type UtilityBillStatus,
  type UtilityBillType,
  type UpdateUtilityBillInput,
} from './utility-bill.types';

type Detail = { field: string; message: string };
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
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
export const parseUtilityBillIdParam = (raw: string): string => parseId(raw, 'utilityBillId');
export const parseUtilityBillTenantIdParam = (raw: string): string => parseId(raw, 'tenantCompanyId');

export function parseGenerateUtilityBillBody(
  body: unknown,
): Omit<GenerateUtilityBillInput, 'tenantCompanyId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const calculationId = readId(body.calculationId, 'calculationId', true, details);
  const dueDate = readDate(body.dueDate, 'dueDate', true, details);
  if (!calculationId || !dueDate || details.length) fail(details);
  return { calculationId, dueDate };
}

export function parseUpdateUtilityBillBody(body: unknown): UpdateUtilityBillInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const immutable = [
    'clientId', 'tenantCompanyId', 'buildingId', 'meterId',
    'tenantAssignmentId', 'calculationId', 'consumptionId', 'utilityType',
    'periodStart', 'periodEnd', 'calculatedUtilityValue', 'billAmount',
  ].find((field) => body[field] !== undefined);
  if (immutable) fail([{ field: immutable, message: 'This field is authoritative or immutable and cannot be updated.' }]);
  const details: Detail[] = [];
  const dueDate = body.dueDate === undefined ? undefined : readDate(body.dueDate, 'dueDate', true, details);
  const status = readStatus(body.status, details);
  if (dueDate === undefined && status === undefined && details.length === 0) {
    details.push({ field: 'body', message: 'At least dueDate or status is required.' });
  }
  if (details.length) fail(details);
  return {
    ...(dueDate ? { dueDate } : {}),
    ...(status ? { status } : {}),
  };
}

export function parseUtilityBillFilters(query: unknown): UtilityBillFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const tenantCompanyId = readId(query.tenantCompanyId, 'tenantCompanyId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const utilityType = readType(query.utilityType, details);
  const status = readStatus(query.status, details);
  const periodFrom = readTimestamp(query.periodFrom, 'periodFrom', details);
  const periodTo = readTimestamp(query.periodTo, 'periodTo', details);
  if (periodFrom && periodTo && periodTo < periodFrom) {
    details.push({ field: 'periodTo', message: 'periodTo must be the same as or after periodFrom.' });
  }
  if (details.length) fail(details);
  return {
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(utilityType ? { utilityType } : {}),
    ...(status ? { status } : {}),
    ...(periodFrom ? { periodFrom } : {}),
    ...(periodTo ? { periodTo } : {}),
  };
}

function readId(value: unknown, field: string, required: boolean, details: Detail[]): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}
function readDate(value: unknown, field: string, required: boolean, details: Detail[]): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || !isCalendarDate(value)) {
    details.push({ field, message: `${field} ${required ? 'is required and ' : ''}must be a valid YYYY-MM-DD date.` });
    return undefined;
  }
  return value;
}
function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function readTimestamp(value: unknown, field: string, details: Detail[]): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: `${field} must be a valid ISO-8601 timestamp.` });
    return undefined;
  }
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    details.push({ field, message: `${field} must be a valid ISO-8601 timestamp.` });
    return undefined;
  }
  return result;
}
function readType(value: unknown, details: Detail[]): UtilityBillType | undefined {
  if (value === undefined) return undefined;
  if (!isUtilityBillType(value)) {
    details.push({ field: 'utilityType', message: `utilityType must be one of: ${UTILITY_BILL_TYPES.join(', ')}.` });
    return undefined;
  }
  return value;
}
function readStatus(value: unknown, details: Detail[]): UtilityBillStatus | undefined {
  if (value === undefined) return undefined;
  if (!isUtilityBillStatus(value)) {
    details.push({ field: 'status', message: `status must be one of: ${UTILITY_BILL_STATUSES.join(', ')}.` });
    return undefined;
  }
  return value;
}
