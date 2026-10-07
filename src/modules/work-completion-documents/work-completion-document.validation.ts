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

export type ValidationDetail = { field: string; message: string };

const DOCUMENT_TYPE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_DOCUMENT_TYPE_LENGTH = 64;
const MAX_DOCUMENT_NUMBER_LENGTH = 64;
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_FILE_REFERENCE_LENGTH = 512;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function fail(d: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', d);
}

function readUuid(v: unknown, field: string, required: boolean, d: ValidationDetail[]): string | undefined {
  if (v === undefined || v === null) {
    if (required) d.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (typeof v !== 'string' || !isValidUuid(v.trim())) {
    d.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return v.trim().toLowerCase();
}
function readRequiredString(v: unknown, field: string, max: number, d: ValidationDetail[], required = true): string | undefined {
  if (v === undefined || v === null) {
    if (required) d.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (typeof v !== 'string' || v.trim() === '') {
    d.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const t = v.trim();
  if (t.length > max) d.push({ field, message: `${field} must be at most ${max} characters.` });
  return t;
}
function readOptionalString(v: unknown, field: string, max: number, d: ValidationDetail[]): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') {
    d.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }
  const t = v.trim();
  if (t === '') return null;
  if (t.length > max) d.push({ field, message: `${field} must be at most ${max} characters.` });
  return t;
}
function readDocType(v: unknown, d: ValidationDetail[], required: boolean): string | undefined {
  if (v === undefined || v === null) {
    if (required) d.push({ field: 'documentType', message: 'documentType is required.' });
    return undefined;
  }
  if (typeof v !== 'string' || v.trim() === '') {
    d.push({ field: 'documentType', message: 'documentType is required.' });
    return undefined;
  }
  const n = v.trim().toUpperCase();
  if (n.length < 2 || n.length > MAX_DOCUMENT_TYPE_LENGTH || !DOCUMENT_TYPE_PATTERN.test(n)) {
    d.push({ field: 'documentType', message: 'documentType must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).' });
    return undefined;
  }
  return n;
}
function readDocNumber(v: unknown, d: ValidationDetail[], required: boolean): string | undefined {
  if (v === undefined || v === null) {
    if (required) d.push({ field: 'documentNumber', message: 'documentNumber is required.' });
    return undefined;
  }
  if (typeof v !== 'string' || v.trim() === '') {
    d.push({ field: 'documentNumber', message: 'documentNumber is required.' });
    return undefined;
  }
  const t = v.trim();
  if (t.length > MAX_DOCUMENT_NUMBER_LENGTH) d.push({ field: 'documentNumber', message: `documentNumber must be at most ${MAX_DOCUMENT_NUMBER_LENGTH} characters.` });
  return t;
}
function readContext(v: unknown, d: ValidationDetail[], required: boolean): DocumentContextType | undefined {
  if (v === undefined || v === null) {
    if (required) d.push({ field: 'contextType', message: 'contextType is required.' });
    return undefined;
  }
  const n = typeof v === 'string' ? v.trim().toUpperCase() : v;
  if (!isDocumentContextType(n)) {
    d.push({ field: 'contextType', message: `contextType must be one of: ${DOCUMENT_CONTEXT_TYPES.join(', ')}.` });
    return undefined;
  }
  return n;
}
function readSourceType(v: unknown, d: ValidationDetail[]): DocumentSourceType | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string' || v.trim() === '') {
    d.push({ field: 'sourceType', message: 'sourceType must be a valid source type or null.' });
    return undefined;
  }
  const n = v.trim().toUpperCase();
  if (!isDocumentSourceType(n)) {
    d.push({ field: 'sourceType', message: `sourceType must be one of: ${DOCUMENT_SOURCE_TYPES.join(', ')}.` });
    return undefined;
  }
  return n;
}
function readStatus(v: unknown, d: ValidationDetail[]): DocumentStatus | undefined {
  if (v === undefined) return undefined;
  if (v === null) {
    d.push({ field: 'status', message: 'status must be a valid status.' });
    return undefined;
  }
  const n = typeof v === 'string' ? v.trim().toUpperCase() : v;
  if (!isDocumentStatus(n)) {
    d.push({ field: 'status', message: `status must be one of: ${DOCUMENT_STATUSES.join(', ')}.` });
    return undefined;
  }
  return n;
}

export function parseCreateWorkCompletionDocumentBody(body: unknown): {
  clientId: string;
  buildingId: string;
  documentNumber: string;
  documentType: string;
  contextType: DocumentContextType;
  sourceType?: DocumentSourceType | null;
  sourceId?: string | null;
  title: string;
  description?: string | null;
  fileReference?: string | null;
  status?: DocumentStatus;
  workOrderId: string;
  vendorWorkId?: string | null;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const d: ValidationDetail[] = [];
  const clientId = readUuid(body.clientId, 'clientId', true, d);
  const buildingId = readUuid(body.buildingId, 'buildingId', true, d);
  const documentNumber = readDocNumber(body.documentNumber, d, true);
  const documentType = readDocType(body.documentType, d, true);
  const contextType = readContext(body.contextType, d, true);
  const sourceType = readSourceType(body.sourceType, d);
  const sourceId = readUuid(body.sourceId, 'sourceId', false, d);
  const title = readRequiredString(body.title, 'title', MAX_TITLE_LENGTH, d, true);
  const description = readOptionalString(body.description, 'description', MAX_DESCRIPTION_LENGTH, d);
  const fileReference = readOptionalString(body.fileReference, 'fileReference', MAX_FILE_REFERENCE_LENGTH, d);
  const status = readStatus(body.status, d);
  const workOrderId = readUuid(body.workOrderId, 'workOrderId', true, d);
  const vendorWorkId = readUuid(body.vendorWorkId, 'vendorWorkId', false, d);

  const hasSourceType = sourceType !== undefined && sourceType !== null;
  const hasSourceId = sourceId !== undefined;
  if (hasSourceType !== hasSourceId) {
    d.push({ field: 'sourceType', message: 'sourceType and sourceId must be provided together.' });
  }
  if (contextType && sourceType !== undefined && sourceType !== null) {
    if (contextType === 'INTERNAL' && sourceType !== 'INTERNAL') d.push({ field: 'sourceType', message: 'INTERNAL context only allows INTERNAL sourceType or no source.' });
    if (contextType === 'TENANT' && sourceType !== 'TENANT_COMPANY') d.push({ field: 'sourceType', message: 'TENANT context requires TENANT_COMPANY sourceType.' });
    if (contextType === 'VENDOR' && sourceType !== 'VENDOR') d.push({ field: 'sourceType', message: 'VENDOR context requires VENDOR sourceType.' });
  }
  if (contextType === 'TENANT' && (sourceType === undefined || sourceType === null)) d.push({ field: 'sourceType', message: 'TENANT context requires TENANT_COMPANY source.' });
  if (contextType === 'VENDOR' && (sourceType === undefined || sourceType === null)) d.push({ field: 'sourceType', message: 'VENDOR context requires VENDOR source.' });

  // vendorWorkId requires workOrderId already validated; no extra check here

  if (!clientId || !buildingId || !documentNumber || !documentType || !contextType || !title || !workOrderId || d.length > 0) fail(d);

  return {
    clientId: clientId!,
    buildingId: buildingId!,
    documentNumber: documentNumber!,
    documentType: documentType!,
    contextType: contextType!,
    ...(sourceType !== undefined ? { sourceType } : {}),
    ...(sourceId !== undefined ? { sourceId } : {}),
    title: title!,
    ...(description !== undefined ? { description } : {}),
    ...(fileReference !== undefined ? { fileReference } : {}),
    ...(status !== undefined ? { status } : {}),
    workOrderId: workOrderId!,
    ...(vendorWorkId !== undefined ? { vendorWorkId } : {}),
  };
}

export function parseWorkCompletionIdParam(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!isValidUuid(v)) fail([{ field: 'id', message: 'Work completion document id must be a valid UUID.' }]);
  return v;
}

export function parseWorkCompletionFilters(query: unknown): {
  workOrderId?: string;
  vendorWorkId?: string;
  buildingId?: string;
  contextType?: DocumentContextType;
  documentType?: string;
  status?: DocumentStatus;
  clientId?: string;
} {
  if (!isRecord(query)) return {};
  const d: ValidationDetail[] = [];
  let workOrderId: string | undefined;
  let vendorWorkId: string | undefined;
  let buildingId: string | undefined;
  let contextType: DocumentContextType | undefined;
  let documentType: string | undefined;
  let status: DocumentStatus | undefined;
  let clientId: string | undefined;

  if (query.workOrderId !== undefined) {
    if (typeof query.workOrderId !== 'string' || !isValidUuid(query.workOrderId.trim())) d.push({ field: 'workOrderId', message: 'workOrderId must be a valid UUID.' }); else workOrderId = query.workOrderId.trim().toLowerCase();
  }
  if (query.vendorWorkId !== undefined) {
    if (typeof query.vendorWorkId !== 'string' || !isValidUuid(query.vendorWorkId.trim())) d.push({ field: 'vendorWorkId', message: 'vendorWorkId must be a valid UUID.' }); else vendorWorkId = query.vendorWorkId.trim().toLowerCase();
  }
  if (query.buildingId !== undefined) {
    if (typeof query.buildingId !== 'string' || !isValidUuid(query.buildingId.trim())) d.push({ field: 'buildingId', message: 'buildingId must be a valid UUID.' }); else buildingId = query.buildingId.trim().toLowerCase();
  }
  if (query.contextType !== undefined) {
    const n = typeof query.contextType === 'string' ? query.contextType.trim().toUpperCase() : query.contextType;
    if (!isDocumentContextType(n)) d.push({ field: 'contextType', message: `contextType must be one of: ${DOCUMENT_CONTEXT_TYPES.join(', ')}.` }); else contextType = n;
  }
  if (query.documentType !== undefined) {
    if (typeof query.documentType !== 'string' || !query.documentType.trim()) d.push({ field: 'documentType', message: 'documentType must be a non-empty string.' }); else {
      const n = query.documentType.trim().toUpperCase();
      if (n.length < 2 || n.length > MAX_DOCUMENT_TYPE_LENGTH || !DOCUMENT_TYPE_PATTERN.test(n)) d.push({ field: 'documentType', message: 'documentType is invalid.' }); else documentType = n;
    }
  }
  if (query.status !== undefined) {
    const n = typeof query.status === 'string' ? query.status.trim().toUpperCase() : query.status;
    if (!isDocumentStatus(n)) d.push({ field: 'status', message: `status must be one of: ${DOCUMENT_STATUSES.join(', ')}.` }); else status = n;
  }
  if (query.clientId !== undefined) {
    if (typeof query.clientId !== 'string' || !isValidUuid(query.clientId.trim())) d.push({ field: 'clientId', message: 'clientId must be a valid UUID.' }); else clientId = query.clientId.trim().toLowerCase();
  }
  if (d.length > 0) fail(d);
  return { ...(workOrderId ? { workOrderId } : {}), ...(vendorWorkId ? { vendorWorkId } : {}), ...(buildingId ? { buildingId } : {}), ...(contextType ? { contextType } : {}), ...(documentType ? { documentType } : {}), ...(status ? { status } : {}), ...(clientId ? { clientId } : {}) };
}
