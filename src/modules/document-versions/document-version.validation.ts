import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

export type ValidationDetail = { field: string; message: string };

function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function fail(d: ValidationDetail[]): never { throw AppError.validation('Request validation failed.', d); }

const MAX_TITLE_LENGTH = 255;
const MAX_DESC_LENGTH = 2000;
const MAX_REF_LENGTH = 512;
const DOC_TYPE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;

export function parseDocumentIdParam(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!isValidUuid(v)) fail([{ field: 'documentId', message: 'Document id must be a valid UUID.' }]);
  return v;
}
export function parseVersionIdParam(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!isValidUuid(v)) fail([{ field: 'versionId', message: 'Version id must be a valid UUID.' }]);
  return v;
}

function readOptionalString(v: unknown, field: string, max: number, d: ValidationDetail[]): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') { d.push({ field, message: `${field} must be a string or null.` }); return undefined; }
  const t = v.trim(); if (t === '') return null; if (t.length > max) d.push({ field, message: `${field} must be at most ${max} characters.` }); return t;
}
function readDocType(v: unknown, d: ValidationDetail[]): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.trim() === '') { d.push({ field: 'documentType', message: 'documentType must be a non-empty string.' }); return undefined; }
  const n = v.trim().toUpperCase(); if (n.length < 2 || n.length > 64 || !DOC_TYPE_PATTERN.test(n)) { d.push({ field: 'documentType', message: 'documentType must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).' }); return undefined; }
  return n;
}
function readStatus(v: unknown, d: ValidationDetail[]): string | undefined {
  if (v === undefined) return undefined;
  if (v === null) { d.push({ field: 'status', message: 'status must be a string.' }); return undefined; }
  if (typeof v !== 'string' || v.trim() === '') { d.push({ field: 'status', message: 'status must be a non-empty string.' }); return undefined; }
  const t = v.trim().toUpperCase();
  if (!['DRAFT', 'ACTIVE', 'INACTIVE'].includes(t)) { d.push({ field: 'status', message: 'status must be one of: DRAFT, ACTIVE, INACTIVE.' }); return undefined; }
  return t;
}

export function parseCreateDocumentVersionBody(body: unknown): { title?: string; description?: string | null; fileReference?: string | null; documentType?: string; status?: string } {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const d: ValidationDetail[] = [];
  const title = readOptionalString(body.title, 'title', MAX_TITLE_LENGTH, d);
  const description = body.description === undefined ? undefined : readOptionalString(body.description, 'description', MAX_DESC_LENGTH, d);
  const fileReference = body.fileReference === undefined ? undefined : readOptionalString(body.fileReference, 'fileReference', MAX_REF_LENGTH, d);
  const documentType = readDocType(body.documentType, d);
  const status = readStatus(body.status, d);

  // At least one field must be provided to create a new version (otherwise it's a duplicate snapshot)
  if (title === undefined && description === undefined && fileReference === undefined && documentType === undefined && status === undefined) {
    // Allow empty body to create a new version as snapshot of current document (still increments version)
    // So we don't fail, just return empty
  }

  if (d.length > 0) fail(d);
  return {
    ...(title !== undefined ? { title: title as string } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(fileReference !== undefined ? { fileReference } : {}),
    ...(documentType !== undefined ? { documentType } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}
