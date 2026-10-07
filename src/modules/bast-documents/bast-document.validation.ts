import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isValidDateFormat } from '../daily-cleaning';
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
import { BAST_STATUSES, isBastStatus, type BastStatus } from './bast-document.types';

export type ValidationDetail = { field: string; message: string };

const MAX_NUMBER_LENGTH = 100;
const MAX_TITLE_LENGTH = 255;
const MAX_DESC_LENGTH = 2000;
const MAX_NOTES_LENGTH = 4000;
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
  const t = v.trim(); if (t.length > 64) d.push({ field: 'documentNumber', message: 'documentNumber must be at most 64 characters.' }); return t;
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
function readBastDate(v: unknown, d: ValidationDetail[]): string | undefined {
  if (v === undefined || v === null) { d.push({ field: 'bastDate', message: 'bastDate is required and must be YYYY-MM-DD.' }); return undefined; }
  if (typeof v !== 'string' || !isValidDateFormat(v.trim())) { d.push({ field: 'bastDate', message: 'bastDate must be a valid YYYY-MM-DD format.' }); return undefined; }
  return v.trim();
}
function readBastNumber(v: unknown, d: ValidationDetail[]): string | undefined {
  if (typeof v !== 'string' || v.trim() === '') { d.push({ field: 'bastNumber', message: 'bastNumber is required.' }); return undefined; }
  const t = v.trim(); if (t.length > MAX_NUMBER_LENGTH) d.push({ field: 'bastNumber', message: `bastNumber must be at most ${MAX_NUMBER_LENGTH} characters.` }); return t;
}

export function parseCreateBastDocumentBody(body: unknown): {
  clientId: string;
  buildingId: string;
  contextType: DocumentContextType;
  sourceType?: DocumentSourceType | null;
  sourceId?: string | null;
  title: string;
  description?: string | null;
  fileReference?: string | null;
  status?: DocumentStatus;
  documentNumber: string;
  documentType: string;
  workOrderId: string;
  vendorWorkId?: string | null;
  workCompletionDocumentId?: string | null;
  bastNumber: string;
  bastDate: string;
  notes?: string | null;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const d: ValidationDetail[] = [];
  const clientId = readUuid(body.clientId, 'clientId', true, d);
  const buildingId = readUuid(body.buildingId, 'buildingId', true, d);
  const contextType = readContext(body.contextType, d, true);
  const sourceType = readSourceType(body.sourceType, d);
  const sourceId = readUuid(body.sourceId, 'sourceId', false, d);
  const title = readRequiredString(body.title, 'title', MAX_TITLE_LENGTH, d);
  const description = readOptionalString(body.description, 'description', MAX_DESC_LENGTH, d);
  const fileReference = readOptionalString(body.fileReference, 'fileReference', MAX_REF_LENGTH, d);
  const status = readStatus(body.status, d);
  const documentNumber = readDocNumber(body.documentNumber, d, true);
  const documentType = readDocType(body.documentType, d, true);
  const workOrderId = readUuid(body.workOrderId, 'workOrderId', true, d);
  const vendorWorkId = readUuid(body.vendorWorkId, 'vendorWorkId', false, d);
  const workCompletionDocumentId = readUuid(body.workCompletionDocumentId, 'workCompletionDocumentId', false, d);
  const bastNumber = readBastNumber(body.bastNumber, d);
  const bastDate = readBastDate(body.bastDate, d);
  const notes = readOptionalString(body.notes, 'notes', MAX_NOTES_LENGTH, d);

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
  if (documentType !== undefined && documentType !== 'BAST') d.push({ field: 'documentType', message: 'documentType must be BAST for canonical BAST creation.' });

  if (!clientId || !buildingId || !contextType || !title || !documentNumber || !documentType || !workOrderId || !bastNumber || !bastDate || d.length > 0) fail(d);

  return {
    clientId: clientId!,
    buildingId: buildingId!,
    contextType: contextType!,
    ...(sourceType !== undefined ? { sourceType } : {}),
    ...(sourceId !== undefined ? { sourceId } : {}),
    title: title!,
    ...(description !== undefined ? { description } : {}),
    ...(fileReference !== undefined ? { fileReference } : {}),
    ...(status !== undefined ? { status } : {}),
    documentNumber: documentNumber!,
    documentType: documentType!,
    workOrderId: workOrderId!,
    ...(vendorWorkId !== undefined ? { vendorWorkId } : {}),
    ...(workCompletionDocumentId !== undefined ? { workCompletionDocumentId } : {}),
    bastNumber: bastNumber!,
    bastDate: bastDate!,
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseBastReconciliationBuildingId(query: unknown): string {
  if (!isRecord(query)) {
    fail([{ field: 'buildingId', message: 'buildingId is required.' }]);
  }
  const buildingId = query.buildingId;
  if (typeof buildingId !== 'string' || !isValidUuid(buildingId.trim())) {
    fail([{ field: 'buildingId', message: 'buildingId must be a valid UUID.' }]);
  }
  return (buildingId as string).trim().toLowerCase();
}

export function parseBastDocumentIdParam(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!isValidUuid(v)) fail([{ field: 'id', message: 'BAST document id must be a valid UUID.' }]);
  return v;
}

export function parseSubmitBastDocumentBody(body: unknown): {
  documentVersionId: string;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];
  const documentVersionId = readUuid(
    body.documentVersionId,
    'documentVersionId',
    true,
    details,
  );
  if (!documentVersionId || details.length > 0) fail(details);
  return { documentVersionId };
}

export function parseDecideBastDocumentBody(body: unknown): {
  decision: 'ACCEPT' | 'REJECT';
  notes?: string | null;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];
  const normalized =
    typeof body.decision === 'string'
      ? body.decision.trim().toUpperCase()
      : body.decision;
  if (normalized !== 'ACCEPT' && normalized !== 'REJECT') {
    details.push({
      field: 'decision',
      message: 'decision must be one of: ACCEPT, REJECT.',
    });
  }
  const notes = readOptionalString(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );
  if (details.length > 0) fail(details);
  return {
    decision: normalized as 'ACCEPT' | 'REJECT',
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseBastDocumentFilters(query: unknown): {
  workOrderId?: string;
  vendorWorkId?: string;
  workCompletionDocumentId?: string;
  buildingId?: string;
  contextType?: DocumentContextType;
  acceptanceStatus?: BastStatus;
  clientId?: string;
  bastNumber?: string;
} {
  if (!isRecord(query)) return {};
  const d: ValidationDetail[] = [];
  let workOrderId: string | undefined;
  let vendorWorkId: string | undefined;
  let workCompletionDocumentId: string | undefined;
  let buildingId: string | undefined;
  let contextType: DocumentContextType | undefined;
  let acceptanceStatus: BastStatus | undefined;
  let clientId: string | undefined;
  let bastNumber: string | undefined;

  if (query.workOrderId !== undefined) {
    if (typeof query.workOrderId !== 'string' || !isValidUuid(query.workOrderId.trim())) d.push({ field: 'workOrderId', message: 'workOrderId must be a valid UUID.' }); else workOrderId = query.workOrderId.trim().toLowerCase();
  }
  if (query.vendorWorkId !== undefined) {
    if (typeof query.vendorWorkId !== 'string' || !isValidUuid(query.vendorWorkId.trim())) d.push({ field: 'vendorWorkId', message: 'vendorWorkId must be a valid UUID.' }); else vendorWorkId = query.vendorWorkId.trim().toLowerCase();
  }
  if (query.workCompletionDocumentId !== undefined) {
    if (typeof query.workCompletionDocumentId !== 'string' || !isValidUuid(query.workCompletionDocumentId.trim())) d.push({ field: 'workCompletionDocumentId', message: 'workCompletionDocumentId must be a valid UUID.' }); else workCompletionDocumentId = query.workCompletionDocumentId.trim().toLowerCase();
  }
  if (query.buildingId !== undefined) {
    if (typeof query.buildingId !== 'string' || !isValidUuid(query.buildingId.trim())) d.push({ field: 'buildingId', message: 'buildingId must be a valid UUID.' }); else buildingId = query.buildingId.trim().toLowerCase();
  }
  if (query.contextType !== undefined) {
    const n = typeof query.contextType === 'string' ? query.contextType.trim().toUpperCase() : query.contextType;
    if (!isDocumentContextType(n)) d.push({ field: 'contextType', message: `contextType must be one of: ${DOCUMENT_CONTEXT_TYPES.join(', ')}.` }); else contextType = n;
  }
  if (query.acceptanceStatus !== undefined) {
    const n = typeof query.acceptanceStatus === 'string' ? query.acceptanceStatus.trim().toUpperCase() : query.acceptanceStatus;
    if (!isBastStatus(n)) d.push({ field: 'acceptanceStatus', message: `acceptanceStatus must be one of: ${BAST_STATUSES.join(', ')}.` }); else acceptanceStatus = n;
  }
  if (query.clientId !== undefined) {
    if (typeof query.clientId !== 'string' || !isValidUuid(query.clientId.trim())) d.push({ field: 'clientId', message: 'clientId must be a valid UUID.' }); else clientId = query.clientId.trim().toLowerCase();
  }
  if (query.bastNumber !== undefined) {
    if (typeof query.bastNumber !== 'string' || !query.bastNumber.trim()) d.push({ field: 'bastNumber', message: 'bastNumber must be a non-empty string.' }); else {
      const t = query.bastNumber.trim(); if (t.length > MAX_NUMBER_LENGTH) d.push({ field: 'bastNumber', message: `bastNumber must be at most ${MAX_NUMBER_LENGTH} characters.` }); else bastNumber = t;
    }
  }
  if (d.length > 0) fail(d);
  return { ...(workOrderId ? { workOrderId } : {}), ...(vendorWorkId ? { vendorWorkId } : {}), ...(workCompletionDocumentId ? { workCompletionDocumentId } : {}), ...(buildingId ? { buildingId } : {}), ...(contextType ? { contextType } : {}), ...(acceptanceStatus ? { acceptanceStatus } : {}), ...(clientId ? { clientId } : {}), ...(bastNumber ? { bastNumber } : {}) };
}
