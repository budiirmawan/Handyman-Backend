import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

export type ValidationDetail = { field: string; message: string };

function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function fail(d: ValidationDetail[]): never { throw AppError.validation('Request validation failed.', d); }

function readUuid(v: unknown, field: string, required: boolean, d: ValidationDetail[]): string | undefined {
  if (v === undefined || v === null) { if (required) d.push({ field, message: `${field} is required.` }); return undefined; }
  if (typeof v !== 'string' || !isValidUuid(v.trim())) { d.push({ field, message: `${field} must be a valid UUID.` }); return undefined; }
  return v.trim().toLowerCase();
}
function readOptionalString(v: unknown, field: string, max: number, d: ValidationDetail[]): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') { d.push({ field, message: `${field} must be a string or null.` }); return undefined; }
  const t = v.trim(); if (t === '') return null; if (t.length > max) d.push({ field, message: `${field} must be at most ${max} characters.` }); return t;
}

export function parseCreateDocumentApprovalBody(body: unknown): { approverUserId: string; notes?: string | null; versionId?: string | null } {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const d: ValidationDetail[] = [];
  const approverUserId = readUuid(body.approverUserId, 'approverUserId', true, d);
  const versionId = readUuid(body.versionId, 'versionId', false, d);
  const notes = readOptionalString(body.notes, 'notes', 4000, d);
  if (!approverUserId || d.length > 0) fail(d);
  return { approverUserId: approverUserId!, ...(versionId !== undefined ? { versionId } : {}), ...(notes !== undefined ? { notes } : {}) };
}

export function parseDocumentApprovalDecisionBody(body: unknown): { notes?: string | null } {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const d: ValidationDetail[] = [];
  const notes = readOptionalString((body as any).notes, 'notes', 4000, d);
  if (d.length > 0) fail(d);
  return notes === undefined ? {} : { notes };
}

export function parseDocumentApprovalIdParam(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!isValidUuid(v)) fail([{ field: 'id', message: 'Approval id must be a valid UUID.' }]);
  return v;
}
export function parseDocumentIdParam(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!isValidUuid(v)) fail([{ field: 'documentId', message: 'Document id must be a valid UUID.' }]);
  return v;
}
