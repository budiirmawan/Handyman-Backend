import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  DOCUMENT_CONTEXT_TYPES,
  DOCUMENT_SOURCE_TYPES,
  DOCUMENT_STATUSES,
  isDocumentContextType,
  isDocumentSourceType,
  isDocumentStatus,
  type DocumentContextType,
  type DocumentSourceType,
  type DocumentStatus,
} from '../documents/document.types';
import { isSupportingParentType, SUPPORTING_PARENT_TYPES, type SupportingParentType } from './supporting-document.types';

export type ValidationDetail = { field: string; message: string };

const MAX_NUMBER_LENGTH = 64;
const MAX_TITLE_LENGTH = 255;
const MAX_DESC_LENGTH = 2000;
const MAX_REF_LENGTH = 512;
const DOC_TYPE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;

function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function fail(d: ValidationDetail[]): never { throw AppError.validation('Request validation failed.', d); }

function readUuid(v: unknown, field: string, required: boolean, d: ValidationDetail[]): string | undefined {
  if (v === undefined || v === null) { if (required) d.push({ field, message: `${field} is required.` }); return undefined; }
  if (typeof v !== 'string' || !isValidUuid(v.trim())) { d.push({ field, message: `${field} must be a valid UUID.` }); return undefined; }
  return v.trim().toLowerCase();
}
function readRequiredString(v: unknown, field: string, max: number, d: ValidationDetail[]): string | undefined {
  if (typeof v !== 'string' || v.trim() === '') { d.push({ field, message: `${field} is required.` }); return undefined; }
  const t = v.trim(); if (t.length > max) d.push({ field, message: `${field} must be at most ${max} characters.` }); return t;
}
function readOptionalString(v: unknown, field: string, max: number, d: ValidationDetail[]): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') { d.push({ field, message: `${field} must be a string or null.` }); return undefined; }
  const t = v.trim(); if (t === '') return null; if (t.length > max) d.push({ field, message: `${field} must be at most ${max} characters.` }); return t;
}
function readDocType(v: unknown, d: ValidationDetail[], required: boolean): string | undefined {
  if (v === undefined || v === null) { if (required) d.push({ field: 'documentType', message: 'documentType is required.' }); return undefined; }
  if (typeof v !== 'string' || v.trim() === '') { d.push({ field: 'documentType', message: 'documentType is required.' }); return undefined; }
  const n = v.trim().toUpperCase(); if (n.length < 2 || n.length > 64 || !DOC_TYPE_PATTERN.test(n)) { d.push({ field: 'documentType', message: 'documentType must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).' }); return undefined; }
  return n;
}
function readDocNumber(v: unknown, d: ValidationDetail[], required: boolean): string | undefined {
  if (v === undefined || v === null) { if (required) d.push({ field: 'documentNumber', message: 'documentNumber is required.' }); return undefined; }
  if (typeof v !== 'string' || v.trim() === '') { d.push({ field: 'documentNumber', message: 'documentNumber is required.' }); return undefined; }
  const t = v.trim(); if (t.length > MAX_NUMBER_LENGTH) d.push({ field: 'documentNumber', message: `documentNumber must be at most ${MAX_NUMBER_LENGTH} characters.` }); return t;
}
function readContext(v: unknown, d: ValidationDetail[], required: boolean): DocumentContextType | undefined {
  if (v === undefined || v === null) { if (required) d.push({ field: 'contextType', message: 'contextType is required.' }); return undefined; }
  const n = typeof v === 'string' ? v.trim().toUpperCase() : v; if (!isDocumentContextType(n)) { d.push({ field: 'contextType', message: `contextType must be one of: ${DOCUMENT_CONTEXT_TYPES.join(', ')}.` }); return undefined; } return n;
}
function readSourceType(v: unknown, d: ValidationDetail[]): DocumentSourceType | null | undefined {
  if (v === undefined) return undefined; if (v === null) return null;
  if (typeof v !== 'string' || v.trim() === '') { d.push({ field: 'sourceType', message: 'sourceType must be a valid source type or null.' }); return undefined; }
  const n = v.trim().toUpperCase(); if (!isDocumentSourceType(n)) { d.push({ field: 'sourceType', message: `sourceType must be one of: ${DOCUMENT_SOURCE_TYPES.join(', ')}.` }); return undefined; } return n;
}
function readStatus(v: unknown, d: ValidationDetail[]): DocumentStatus | undefined {
  if (v === undefined) return undefined; const n = typeof v === 'string' ? v.trim().toUpperCase() : v; if (!isDocumentStatus(n)) { d.push({ field: 'status', message: `status must be one of: ${DOCUMENT_STATUSES.join(', ')}.` }); return undefined; } return n;
}
function readParentType(v: unknown, d: ValidationDetail[]): SupportingParentType | undefined {
  if (v === undefined || v === null) { d.push({ field: 'parentType', message: 'parentType is required.' }); return undefined; }
  const n = typeof v === 'string' ? v.trim().toUpperCase() : v; if (!isSupportingParentType(n)) { d.push({ field: 'parentType', message: `parentType must be one of: ${SUPPORTING_PARENT_TYPES.join(', ')}.` }); return undefined; } return n;
}

export function parseCreateSupportingDocumentBody(body: unknown): {
  clientId: string;
  buildingId?: string | null;
  contextType: DocumentContextType;
  sourceType?: DocumentSourceType | null;
  sourceId?: string | null;
  title: string;
  description?: string | null;
  fileReference: string;
  status?: DocumentStatus;
  documentNumber: string;
  documentType: string;
  parentType: SupportingParentType;
  parentId: string;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const d: ValidationDetail[] = [];
  const clientId = readUuid(body.clientId, 'clientId', true, d);
  const buildingId = readUuid(body.buildingId, 'buildingId', false, d);
  const contextType = readContext(body.contextType, d, true);
  const sourceType = readSourceType(body.sourceType, d);
  const sourceId = readUuid(body.sourceId, 'sourceId', false, d);
  const title = readRequiredString(body.title, 'title', MAX_TITLE_LENGTH, d);
  const description = readOptionalString(body.description, 'description', MAX_DESC_LENGTH, d);
  const fileReference = readRequiredString(body.fileReference, 'fileReference', MAX_REF_LENGTH, d);
  const status = readStatus(body.status, d);
  const documentNumber = readDocNumber(body.documentNumber, d, true);
  const documentType = readDocType(body.documentType, d, true);
  const parentType = readParentType(body.parentType, d);
  const parentId = readUuid(body.parentId, 'parentId', true, d);

  const hasSourceType = sourceType !== undefined && sourceType !== null;
  const hasSourceId = sourceId !== undefined;
  if (hasSourceType !== hasSourceId) d.push({ field: 'sourceType', message: 'sourceType and sourceId must be provided together.' });
  if (contextType && sourceType !== undefined && sourceType !== null) {
    if (contextType === 'INTERNAL' && sourceType !== 'INTERNAL') d.push({ field: 'sourceType', message: 'INTERNAL context only allows INTERNAL sourceType or no source.' });
    if (contextType === 'TENANT' && sourceType !== 'TENANT_COMPANY') d.push({ field: 'sourceType', message: 'TENANT context requires TENANT_COMPANY sourceType.' });
    if (contextType === 'VENDOR' && sourceType !== 'VENDOR') d.push({ field: 'sourceType', message: 'VENDOR context requires VENDOR sourceType.' });
  }
  if (contextType === 'TENANT' && (sourceType === undefined || sourceType === null)) d.push({ field: 'sourceType', message: 'TENANT context requires TENANT_COMPANY source.' });
  if (contextType === 'VENDOR' && (sourceType === undefined || sourceType === null)) d.push({ field: 'sourceType', message: 'VENDOR context requires VENDOR source.' });

  if (!clientId || !contextType || !title || !fileReference || !documentNumber || !documentType || !parentType || !parentId || d.length > 0) fail(d);

  return {
    clientId: clientId!,
    ...(buildingId !== undefined ? { buildingId } : {}),
    contextType: contextType!,
    ...(sourceType !== undefined ? { sourceType } : {}),
    ...(sourceId !== undefined ? { sourceId } : {}),
    title: title!,
    ...(description !== undefined ? { description } : {}),
    fileReference: fileReference!,
    ...(status !== undefined ? { status } : {}),
    documentNumber: documentNumber!,
    documentType: documentType!,
    parentType: parentType!,
    parentId: parentId!,
  };
}

export function parseSupportingDocumentIdParam(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!isValidUuid(v)) fail([{ field: 'id', message: 'Supporting document id must be a valid UUID.' }]);
  return v;
}

export function parseSupportingDocumentFilters(query: unknown): {
  parentType?: SupportingParentType;
  parentId?: string;
  buildingId?: string;
  contextType?: DocumentContextType;
  clientId?: string;
  documentType?: string;
} {
  if (!isRecord(query)) return {};
  const d: ValidationDetail[] = [];
  let parentType: SupportingParentType | undefined;
  let parentId: string | undefined;
  let buildingId: string | undefined;
  let contextType: DocumentContextType | undefined;
  let clientId: string | undefined;
  let documentType: string | undefined;

  if (query.parentType !== undefined) {
    const n = typeof query.parentType === 'string' ? query.parentType.trim().toUpperCase() : query.parentType;
    if (!isSupportingParentType(n)) d.push({ field: 'parentType', message: `parentType must be one of: ${SUPPORTING_PARENT_TYPES.join(', ')}.` }); else parentType = n;
  }
  if (query.parentId !== undefined) {
    if (typeof query.parentId !== 'string' || !isValidUuid(query.parentId.trim())) d.push({ field: 'parentId', message: 'parentId must be a valid UUID.' }); else parentId = query.parentId.trim().toLowerCase();
  }
  if (query.buildingId !== undefined) {
    if (typeof query.buildingId !== 'string' || !isValidUuid(query.buildingId.trim())) d.push({ field: 'buildingId', message: 'buildingId must be a valid UUID.' }); else buildingId = query.buildingId.trim().toLowerCase();
  }
  if (query.contextType !== undefined) {
    const n = typeof query.contextType === 'string' ? query.contextType.trim().toUpperCase() : query.contextType;
    if (!isDocumentContextType(n)) d.push({ field: 'contextType', message: `contextType must be one of: ${DOCUMENT_CONTEXT_TYPES.join(', ')}.` }); else contextType = n;
  }
  if (query.clientId !== undefined) {
    if (typeof query.clientId !== 'string' || !isValidUuid(query.clientId.trim())) d.push({ field: 'clientId', message: 'clientId must be a valid UUID.' }); else clientId = query.clientId.trim().toLowerCase();
  }
  if (query.documentType !== undefined) {
    if (typeof query.documentType !== 'string' || !query.documentType.trim()) d.push({ field: 'documentType', message: 'documentType must be a non-empty string.' }); else {
      const n = query.documentType.trim().toUpperCase();
      if (n.length < 2 || n.length > 64 || !DOC_TYPE_PATTERN.test(n)) d.push({ field: 'documentType', message: 'documentType is invalid.' }); else documentType = n;
    }
  }
  // ParentType and parentId should be provided together if one is provided
  if ((parentType !== undefined && parentId === undefined) || (parentType === undefined && parentId !== undefined)) {
    d.push({ field: 'parentType', message: 'parentType and parentId must be provided together.' });
  }
  if (d.length > 0) fail(d);
  return { ...(parentType ? { parentType } : {}), ...(parentId ? { parentId } : {}), ...(buildingId ? { buildingId } : {}), ...(contextType ? { contextType } : {}), ...(clientId ? { clientId } : {}), ...(documentType ? { documentType } : {}) };
}
