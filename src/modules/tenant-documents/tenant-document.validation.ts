import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  TENANT_DOCUMENT_STATUSES,
  isTenantDocumentStatus,
  type CreateTenantDocumentInput,
  type TenantDocumentFilters,
  type TenantDocumentStatus,
  type UpdateTenantDocumentInput,
} from './tenant-document.types';

type Detail = { field: string; message: string };
const TYPE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
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
export const parseTenantDocumentIdParam = (raw: string): string =>
  parseId(raw, 'tenantDocumentId');
export const parseTenantDocumentCompanyIdParam = (raw: string): string =>
  parseId(raw, 'tenantCompanyId');

export function normalizeTenantDocumentType(value: string): string {
  return value.trim().toUpperCase();
}
export function isValidTenantDocumentType(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && TYPE_PATTERN.test(value);
}

export function parseCreateTenantDocumentBody(
  body: unknown,
): Omit<CreateTenantDocumentInput, 'tenantCompanyId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const buildingId = readId(body.buildingId, 'buildingId', false, details);
  const documentType = readType(body.documentType, details);
  const documentName = readRequiredString(body.documentName, 'documentName', 255, details);
  const documentNumber = readRequiredString(body.documentNumber, 'documentNumber', 128, details);
  const issueDate = readDate(body.issueDate, 'issueDate', details);
  const expiryDate = readDate(body.expiryDate, 'expiryDate', details);
  const fileReference = readFileReference(body.fileReference, details);
  const status = readStatus(body.status, details);
  const notes = readOptionalString(body.notes, 'notes', 1024, details);
  assertOrder(issueDate, expiryDate, details);
  if (!documentType || !documentName || !documentNumber || details.length) fail(details);
  return {
    ...(buildingId ? { buildingId } : {}),
    documentType,
    documentName,
    documentNumber,
    ...(issueDate !== undefined ? { issueDate } : {}),
    ...(expiryDate !== undefined ? { expiryDate } : {}),
    ...(fileReference ? { fileReference } : {}),
    ...(status ? { status } : {}),
    ...(notes ? { notes } : {}),
  };
}

export function parseUpdateTenantDocumentBody(
  body: unknown,
): UpdateTenantDocumentInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const immutable = ['clientId', 'tenantCompanyId', 'buildingId'].find(
    (field) => body[field] !== undefined,
  );
  if (immutable) fail([{ field: immutable, message: 'This field is immutable and cannot be updated.' }]);
  const details: Detail[] = [];
  const documentType = body.documentType === undefined
    ? undefined : readType(body.documentType, details);
  const documentName = body.documentName === undefined
    ? undefined : readRequiredString(body.documentName, 'documentName', 255, details);
  const documentNumber = body.documentNumber === undefined
    ? undefined : readRequiredString(body.documentNumber, 'documentNumber', 128, details);
  const issueDate = readDate(body.issueDate, 'issueDate', details);
  const expiryDate = readDate(body.expiryDate, 'expiryDate', details);
  const fileReference = body.fileReference === null
    ? null : readFileReference(body.fileReference, details);
  const status = readStatus(body.status, details);
  const notes = body.notes === null
    ? null : readOptionalString(body.notes, 'notes', 1024, details);
  assertOrder(issueDate, expiryDate, details);
  if (details.length) fail(details);
  return {
    ...(documentType !== undefined ? { documentType } : {}),
    ...(documentName !== undefined ? { documentName } : {}),
    ...(documentNumber !== undefined ? { documentNumber } : {}),
    ...(issueDate !== undefined ? { issueDate } : {}),
    ...(expiryDate !== undefined ? { expiryDate } : {}),
    ...(fileReference !== undefined ? { fileReference } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseTenantDocumentFilters(query: unknown): TenantDocumentFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const documentType = query.documentType === undefined
    ? undefined : readType(query.documentType, details);
  const status = readStatus(query.status, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  if (details.length) fail(details);
  return {
    ...(documentType ? { documentType } : {}),
    ...(status ? { status } : {}),
    ...(buildingId ? { buildingId } : {}),
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
function readType(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'documentType', message: 'documentType is required.' });
    return undefined;
  }
  const result = normalizeTenantDocumentType(value);
  if (!isValidTenantDocumentType(result)) {
    details.push({ field: 'documentType', message: 'documentType must be a valid data-driven code.' });
    return undefined;
  }
  return result;
}
function readRequiredString(value: unknown, field: string, max: number, details: Detail[]): string | undefined {
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
function readOptionalString(value: unknown, field: string, max: number, details: Detail[]): string | undefined {
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
function readFileReference(value: unknown, details: Detail[]): string | undefined {
  const result = readOptionalString(value, 'fileReference', 512, details);
  if (result?.toLowerCase().startsWith('data:')) {
    details.push({
      field: 'fileReference',
      message: 'fileReference must be an opaque storage reference, not inline file data.',
    });
    return undefined;
  }
  return result;
}
function readDate(value: unknown, field: string, details: Detail[]): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: `${field} must be an ISO-8601 date string or null.` });
    return undefined;
  }
  const result = new Date(value.trim());
  if (Number.isNaN(result.getTime())) {
    details.push({ field, message: `${field} must be a valid ISO-8601 date string.` });
    return undefined;
  }
  return result;
}
function assertOrder(
  issue: Date | null | undefined,
  expiry: Date | null | undefined,
  details: Detail[],
): void {
  if (issue instanceof Date && expiry instanceof Date && expiry < issue) {
    details.push({ field: 'expiryDate', message: 'expiryDate must be the same as or after issueDate.' });
  }
}
function readStatus(value: unknown, details: Detail[]): TenantDocumentStatus | undefined {
  if (value === undefined) return undefined;
  if (!isTenantDocumentStatus(value)) {
    details.push({ field: 'status', message: `status must be one of: ${TENANT_DOCUMENT_STATUSES.join(', ')}.` });
    return undefined;
  }
  return value;
}
