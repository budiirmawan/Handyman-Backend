import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  TENANT_PIC_STATUSES,
  isTenantPicStatus,
  type CreateTenantPicInput,
  type TenantPicStatus,
  type UpdateTenantPicInput,
} from './tenant-pic.types';

type Detail = { field: string; message: string };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9()\-\s.]{5,}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export function parseTenantPicIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'tenantPicId', message: 'Tenant PIC id must be a valid UUID.' }]);
  }
  return value;
}

export function parseTenantPicCompanyIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'tenantCompanyId', message: 'Tenant company id must be a valid UUID.' }]);
  }
  return value;
}

export function parseCreateTenantPicBody(
  body: unknown,
): Omit<CreateTenantPicInput, 'tenantCompanyId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const userId = readUserId(body.userId, false, details);
  const picName = requiredString(body.picName, 'picName', 160, details);
  const email = optionalEmail(body.email, details);
  const phone = optionalPhone(body.phone, details);
  const roleTitle = optionalString(body.roleTitle, 'roleTitle', 128, details);
  const isPrimary = readBoolean(body.isPrimary, 'isPrimary', details);
  const status = readStatus(body.status, details);
  if (!picName || details.length) fail(details);
  return {
    ...(typeof userId === 'string' ? { userId } : {}),
    picName,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(roleTitle ? { roleTitle } : {}),
    ...(isPrimary !== undefined ? { isPrimary } : {}),
    ...(status ? { status } : {}),
  };
}

export function parseUpdateTenantPicBody(body: unknown): UpdateTenantPicInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  if (body.tenantCompanyId !== undefined) {
    fail([{ field: 'tenantCompanyId', message: 'This field is immutable and cannot be updated.' }]);
  }
  const details: Detail[] = [];
  const userId = readUserId(body.userId, true, details);
  const picName = body.picName === undefined
    ? undefined
    : requiredString(body.picName, 'picName', 160, details);
  const email = body.email === null ? null : optionalEmail(body.email, details);
  const phone = body.phone === null ? null : optionalPhone(body.phone, details);
  const roleTitle = body.roleTitle === null
    ? null
    : optionalString(body.roleTitle, 'roleTitle', 128, details);
  const isPrimary = readBoolean(body.isPrimary, 'isPrimary', details);
  const status = readStatus(body.status, details);
  if (details.length) fail(details);
  return {
    ...(userId !== undefined ? { userId } : {}),
    ...(picName !== undefined ? { picName } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(roleTitle !== undefined ? { roleTitle } : {}),
    ...(isPrimary !== undefined ? { isPrimary } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function readUserId(
  value: unknown,
  nullable: boolean,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'userId',
      message: `userId must be a valid UUID${nullable ? ' or null' : ''}.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function requiredString(
  value: unknown,
  field: string,
  max: number,
  details: Detail[],
): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const result = value.trim();
  if (result.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return result;
}

function optionalString(
  value: unknown,
  field: string,
  max: number,
  details: Detail[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const result = value.trim();
  if (!result) return undefined;
  if (result.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return result;
}

function optionalEmail(value: unknown, details: Detail[]): string | undefined {
  const result = optionalString(value, 'email', 255, details)?.toLowerCase();
  if (result && !EMAIL_PATTERN.test(result)) {
    details.push({ field: 'email', message: 'email must be a valid email address.' });
    return undefined;
  }
  return result;
}

function optionalPhone(value: unknown, details: Detail[]): string | undefined {
  const result = optionalString(value, 'phone', 32, details);
  if (result && !PHONE_PATTERN.test(result)) {
    details.push({ field: 'phone', message: 'phone has an invalid format.' });
    return undefined;
  }
  return result;
}

function readBoolean(
  value: unknown,
  field: string,
  details: Detail[],
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    details.push({ field, message: `${field} must be a boolean.` });
    return undefined;
  }
  return value;
}

function readStatus(value: unknown, details: Detail[]): TenantPicStatus | undefined {
  if (value === undefined) return undefined;
  if (!isTenantPicStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${TENANT_PIC_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}
