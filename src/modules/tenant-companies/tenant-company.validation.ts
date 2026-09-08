import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  TENANT_COMPANY_STATUSES,
  isTenantCompanyStatus,
  type CreateTenantCompanyInput,
  type TenantCompanyListFilters,
  type TenantCompanyStatus,
  type UpdateTenantCompanyInput,
} from './tenant-company.types';

type Detail = { field: string; message: string };
const CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9()\-\s.]{5,}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(details: Detail[]): never { throw AppError.validation('Request validation failed.', details); }

export function normalizeTenantCompanyCode(value: string): string { return value.trim().toUpperCase(); }
export function isValidTenantCompanyCode(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && CODE_PATTERN.test(value);
}

export function parseTenantCompanyIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'tenantCompanyId', message: 'Tenant company id must be a valid UUID.' }]);
  return value;
}
export function parseTenantCompanyClientIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'clientId', message: 'Client id must be a valid UUID.' }]);
  return value;
}

export function parseCreateTenantCompanyBody(body: unknown): Omit<CreateTenantCompanyInput, 'clientId'> {
  if (!object(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const tenantCode = code(body.tenantCode, details);
  const tenantName = requiredString(body.tenantName, 'tenantName', 160, details);
  const legalName = optionalString(body.legalName, 'legalName', 255, details);
  const email = optionalEmail(body.email, details);
  const phone = optionalPhone(body.phone, details);
  const address = optionalString(body.address, 'address', 512, details);
  const status = readStatus(body.status, details);
  if (!tenantCode || !tenantName || details.length) fail(details);
  return { tenantCode, tenantName, ...(legalName ? { legalName } : {}), ...(email ? { email } : {}),
    ...(phone ? { phone } : {}), ...(address ? { address } : {}), ...(status ? { status } : {}) };
}

export function parseUpdateTenantCompanyBody(body: unknown): UpdateTenantCompanyInput {
  if (!object(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  if (body.clientId !== undefined || body.tenantCode !== undefined) {
    const field = body.clientId !== undefined ? 'clientId' : 'tenantCode';
    fail([{ field, message: 'This field is immutable and cannot be updated.' }]);
  }
  const details: Detail[] = [];
  const tenantName = body.tenantName === undefined ? undefined : requiredString(body.tenantName, 'tenantName', 160, details);
  const legalName = nullableString(body.legalName, 'legalName', 255, details);
  const email = body.email === null ? null : optionalEmail(body.email, details);
  const phone = body.phone === null ? null : optionalPhone(body.phone, details);
  const address = nullableString(body.address, 'address', 512, details);
  const status = readStatus(body.status, details);
  if (details.length) fail(details);
  return { ...(tenantName !== undefined ? { tenantName } : {}), ...(legalName !== undefined ? { legalName } : {}),
    ...(email !== undefined ? { email } : {}), ...(phone !== undefined ? { phone } : {}),
    ...(address !== undefined ? { address } : {}), ...(status !== undefined ? { status } : {}) };
}

export function parseTenantCompanyListQuery(query: Record<string, unknown>): TenantCompanyListFilters {
  const details: Detail[] = [];
  const search = optionalString(query.search, 'search', 160, details);
  const status = readStatus(query.status, details);
  if (details.length) fail(details);
  return { ...(search ? { search } : {}), ...(status ? { status } : {}) };
}

function code(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') { details.push({ field: 'tenantCode', message: 'Tenant code is required.' }); return; }
  const normalized = normalizeTenantCompanyCode(value);
  if (!isValidTenantCompanyCode(normalized)) {
    details.push({ field: 'tenantCode', message: 'Tenant code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).' }); return;
  }
  return normalized;
}
function requiredString(value: unknown, field: string, max: number, details: Detail[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) { details.push({ field, message: `${field} is required.` }); return; }
  const result = value.trim();
  if (result.length > max) { details.push({ field, message: `${field} must be at most ${max} characters.` }); return; }
  return result;
}
function optionalString(value: unknown, field: string, max: number, details: Detail[]): string | undefined {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') { details.push({ field, message: `${field} must be a string.` }); return; }
  const result = value.trim();
  if (!result) return;
  if (result.length > max) { details.push({ field, message: `${field} must be at most ${max} characters.` }); return; }
  return result;
}
function nullableString(value: unknown, field: string, max: number, details: Detail[]): string | null | undefined {
  return value === null ? null : optionalString(value, field, max, details);
}
function optionalEmail(value: unknown, details: Detail[]): string | undefined {
  const result = optionalString(value, 'email', 255, details)?.toLowerCase();
  if (result && !EMAIL_PATTERN.test(result)) { details.push({ field: 'email', message: 'email must be a valid email address.' }); return; }
  return result;
}
function optionalPhone(value: unknown, details: Detail[]): string | undefined {
  const result = optionalString(value, 'phone', 32, details);
  if (result && !PHONE_PATTERN.test(result)) { details.push({ field: 'phone', message: 'phone has an invalid format.' }); return; }
  return result;
}
function readStatus(value: unknown, details: Detail[]): TenantCompanyStatus | undefined {
  if (value === undefined) return;
  if (!isTenantCompanyStatus(value)) { details.push({ field: 'status', message: `Status must be one of: ${TENANT_COMPANY_STATUSES.join(', ')}.` }); return; }
  return value;
}
