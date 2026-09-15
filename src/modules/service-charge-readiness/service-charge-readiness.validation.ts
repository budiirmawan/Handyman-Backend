import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  SERVICE_CHARGE_READINESS_STATUSES,
  isServiceChargeReadinessStatus,
  type CreateServiceChargeReadinessInput,
  type ServiceChargeReadinessFilters,
  type ServiceChargeReadinessStatus,
  type UpdateServiceChargeReadinessInput,
} from './service-charge-readiness.types';

type Detail = { field: string; message: string };
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
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
export const parseServiceChargeReadinessIdParam = (raw: string): string => parseId(raw, 'serviceChargeReadinessId');
export const parseServiceChargeReadinessTenantIdParam = (raw: string): string => parseId(raw, 'tenantCompanyId');

export function parseCreateServiceChargeReadinessBody(
  body: unknown,
): Omit<CreateServiceChargeReadinessInput, 'tenantCompanyId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const spaceId = readId(body.spaceId, 'spaceId', true, details);
  const serviceChargeType = readType(body.serviceChargeType, true, details);
  const chargeBasis = readNullableString(body.chargeBasis, 'chargeBasis', 500, details);
  const tenantChargeId = readNullableId(body.tenantChargeId, 'tenantChargeId', details);
  const effectiveFrom = readDate(body.effectiveFrom, 'effectiveFrom', true, details);
  const effectiveTo = readDate(body.effectiveTo, 'effectiveTo', true, details);
  const readinessStatus = readStatus(body.readinessStatus, details);
  const notes = readString(body.notes, 'notes', 2000, details);
  assertPeriod(effectiveFrom, effectiveTo, details);
  if (!buildingId || !spaceId || !serviceChargeType || !effectiveFrom || !effectiveTo || details.length) fail(details);
  return {
    buildingId, spaceId, serviceChargeType,
    ...(chargeBasis !== undefined ? { chargeBasis } : {}),
    ...(tenantChargeId !== undefined ? { tenantChargeId } : {}),
    effectiveFrom, effectiveTo,
    ...(readinessStatus ? { readinessStatus } : {}),
    ...(notes ? { notes } : {}),
  };
}
export function parseUpdateServiceChargeReadinessBody(body: unknown): UpdateServiceChargeReadinessInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const immutable = ['clientId', 'tenantCompanyId', 'buildingId', 'spaceId', 'evaluatedByUserId']
    .find((field) => body[field] !== undefined);
  if (immutable) fail([{ field: immutable, message: 'This context field is immutable.' }]);
  const details: Detail[] = [];
  const serviceChargeType = body.serviceChargeType === undefined ? undefined : readType(body.serviceChargeType, true, details);
  const chargeBasis = readNullableString(body.chargeBasis, 'chargeBasis', 500, details);
  const tenantChargeId = readNullableId(body.tenantChargeId, 'tenantChargeId', details);
  const effectiveFrom = body.effectiveFrom === undefined ? undefined : readDate(body.effectiveFrom, 'effectiveFrom', true, details);
  const effectiveTo = body.effectiveTo === undefined ? undefined : readDate(body.effectiveTo, 'effectiveTo', true, details);
  const readinessStatus = readStatus(body.readinessStatus, details);
  const notes = body.notes === null ? null : readString(body.notes, 'notes', 2000, details);
  assertPeriod(effectiveFrom, effectiveTo, details);
  const result: UpdateServiceChargeReadinessInput = {
    ...(serviceChargeType !== undefined ? { serviceChargeType } : {}),
    ...(chargeBasis !== undefined ? { chargeBasis } : {}),
    ...(tenantChargeId !== undefined ? { tenantChargeId } : {}),
    ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
    ...(effectiveTo !== undefined ? { effectiveTo } : {}),
    ...(readinessStatus !== undefined ? { readinessStatus } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  if (Object.keys(result).length === 0 && details.length === 0) {
    details.push({ field: 'body', message: 'At least one readiness field is required.' });
  }
  if (details.length) fail(details);
  return result;
}
export function parseServiceChargeReadinessFilters(query: unknown): ServiceChargeReadinessFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const tenantCompanyId = readId(query.tenantCompanyId, 'tenantCompanyId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const status = readStatus(query.status, details);
  const periodFrom = readDate(query.periodFrom, 'periodFrom', false, details);
  const periodTo = readDate(query.periodTo, 'periodTo', false, details);
  assertPeriod(periodFrom, periodTo, details, 'periodTo');
  if (details.length) fail(details);
  return {
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    ...(buildingId ? { buildingId } : {}),
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
function readNullableId(value: unknown, field: string, details: Detail[]): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readId(value, field, true, details);
}
function readType(value: unknown, required: boolean, details: Detail[]): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') {
    details.push({ field: 'serviceChargeType', message: 'serviceChargeType is required.' });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!CODE_PATTERN.test(normalized)) {
    details.push({ field: 'serviceChargeType', message: 'serviceChargeType must be a valid data-driven code.' });
    return undefined;
  }
  return normalized;
}
function readNullableString(value: unknown, field: string, max: number, details: Detail[]): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readString(value, field, max, details) ?? null;
}
function readString(value: unknown, field: string, max: number, details: Detail[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: `${field} must be a non-empty string.` });
    return undefined;
  }
  const result = value.trim();
  if (result.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return result;
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
function assertPeriod(from: string | undefined, to: string | undefined, details: Detail[], field = 'effectiveTo'): void {
  if (from && to && to < from) details.push({ field, message: `${field} must be the same as or after the period start.` });
}
function readStatus(value: unknown, details: Detail[]): ServiceChargeReadinessStatus | undefined {
  if (value === undefined) return undefined;
  if (!isServiceChargeReadinessStatus(value)) {
    details.push({ field: 'readinessStatus', message: `readinessStatus must be one of: ${SERVICE_CHARGE_READINESS_STATUSES.join(', ')}.` });
    return undefined;
  }
  return value;
}
