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
} from './document.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const DOCUMENT_TYPE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_DOCUMENT_TYPE_LENGTH = 64;
const MAX_DOCUMENT_NUMBER_LENGTH = 64;
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_FILE_REFERENCE_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export function parseDocumentIdParam(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!isValidUuid(v)) {
    fail([{ field: 'id', message: 'Document id must be a valid UUID.' }]);
  }
  return v;
}

function normalizeDocType(value: string): string {
  return value.trim().toUpperCase();
}

function readUuid(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    if (required) {
      details.push({ field, message: `${field} is required.` });
    }
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readRequiredString(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
  required = true,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return trimmed;
}

function readOptionalString(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return trimmed;
}

function readDocumentType(
  value: unknown,
  details: ValidationDetail[],
  required: boolean,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) details.push({ field: 'documentType', message: 'documentType is required.' });
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field: 'documentType', message: 'documentType is required.' });
    return undefined;
  }
  const normalized = normalizeDocType(value);
  if (
    normalized.length < 2 ||
    normalized.length > MAX_DOCUMENT_TYPE_LENGTH ||
    !DOCUMENT_TYPE_PATTERN.test(normalized)
  ) {
    details.push({
      field: 'documentType',
      message:
        'documentType must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }
  return normalized;
}

function readDocumentNumber(
  value: unknown,
  details: ValidationDetail[],
  required: boolean,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) details.push({ field: 'documentNumber', message: 'documentNumber is required.' });
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field: 'documentNumber', message: 'documentNumber is required.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_DOCUMENT_NUMBER_LENGTH) {
    details.push({ field: 'documentNumber', message: `documentNumber must be at most ${MAX_DOCUMENT_NUMBER_LENGTH} characters.` });
    return undefined;
  }
  return trimmed;
}

function readContextType(
  value: unknown,
  details: ValidationDetail[],
  required: boolean,
): DocumentContextType | undefined {
  if (value === undefined || value === null) {
    if (required) details.push({ field: 'contextType', message: 'contextType is required.' });
    return undefined;
  }
  const normalized =
    typeof value === 'string' ? value.trim().toUpperCase() : value;
  if (!isDocumentContextType(normalized)) {
    details.push({
      field: 'contextType',
      message: `contextType must be one of: ${DOCUMENT_CONTEXT_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readSourceType(
  value: unknown,
  details: ValidationDetail[],
): DocumentSourceType | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field: 'sourceType', message: 'sourceType must be a valid source type or null.' });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!isDocumentSourceType(normalized)) {
    details.push({
      field: 'sourceType',
      message: `sourceType must be one of: ${DOCUMENT_SOURCE_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): DocumentStatus | undefined {
  if (value === undefined) return undefined;
  if (value === null) {
    details.push({ field: 'status', message: 'status must be a valid status.' });
    return undefined;
  }
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : value;
  if (!isDocumentStatus(normalized)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${DOCUMENT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

export function parseCreateDocumentBody(body: unknown): {
  clientId: string;
  buildingId?: string | null;
  documentNumber: string;
  documentType: string;
  contextType: DocumentContextType;
  sourceType?: DocumentSourceType | null;
  sourceId?: string | null;
  title: string;
  description?: string | null;
  fileReference?: string | null;
  status?: DocumentStatus;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];

  const clientId = readUuid(body.clientId, 'clientId', true, details);
  const buildingId = readUuid(body.buildingId, 'buildingId', false, details);
  const documentNumber = readDocumentNumber(body.documentNumber, details, true);
  const documentType = readDocumentType(body.documentType, details, true);
  const contextType = readContextType(body.contextType, details, true);
  const sourceType = readSourceType(body.sourceType, details);
  const sourceId = readUuid(body.sourceId, 'sourceId', false, details);
  const title = readRequiredString(body.title, 'title', MAX_TITLE_LENGTH, details, true);
  const description = readOptionalString(body.description, 'description', MAX_DESCRIPTION_LENGTH, details);
  const fileReference = readOptionalString(body.fileReference, 'fileReference', MAX_FILE_REFERENCE_LENGTH, details);
  const status = readStatus(body.status, details);

  // Cross-field: sourceType/sourceId must be paired
  if ((sourceType !== undefined && sourceType !== null) || sourceId !== undefined) {
    const effectiveSourceType = sourceType;
    const effectiveSourceId = sourceId;
    const hasType = effectiveSourceType !== undefined && effectiveSourceType !== null;
    const hasId = effectiveSourceId !== undefined && effectiveSourceId !== null;
    if (hasType !== hasId) {
      details.push({ field: 'sourceType', message: 'sourceType and sourceId must be provided together.' });
    }
  }

  // Validate context/source invariants (minimal, service re-validates with DB)
  if (contextType && sourceType !== undefined && sourceType !== null) {
    if (contextType === 'INTERNAL' && sourceType !== 'INTERNAL') {
      details.push({ field: 'sourceType', message: 'INTERNAL context only allows INTERNAL sourceType or no source.' });
    }
    if (contextType === 'TENANT' && sourceType !== 'TENANT_COMPANY') {
      details.push({ field: 'sourceType', message: 'TENANT context requires TENANT_COMPANY sourceType.' });
    }
    if (contextType === 'VENDOR' && sourceType !== 'VENDOR') {
      details.push({ field: 'sourceType', message: 'VENDOR context requires VENDOR sourceType.' });
    }
  }
  if (contextType === 'TENANT' && (sourceType === undefined || sourceType === null) && sourceId === undefined) {
    // TENANT without source will be caught in service as invalid; but we also flag
    // For minimal strictness, allow later service to decide; still need source for tenant/vendor? Enforce here:
    details.push({ field: 'sourceType', message: 'TENANT context requires TENANT_COMPANY source.' });
  }
  if (contextType === 'VENDOR' && (sourceType === undefined || sourceType === null)) {
    details.push({ field: 'sourceType', message: 'VENDOR context requires VENDOR source.' });
  }

  if (
    !clientId ||
    !documentNumber ||
    !documentType ||
    !contextType ||
    !title ||
    details.length > 0
  ) {
    fail(details);
  }

  return {
    clientId,
    ...(buildingId !== undefined ? { buildingId } : {}),
    documentNumber,
    documentType,
    contextType,
    ...(sourceType !== undefined ? { sourceType } : {}),
    ...(sourceId !== undefined ? { sourceId } : {}),
    title,
    ...(description !== undefined ? { description } : {}),
    ...(fileReference !== undefined ? { fileReference } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseUpdateDocumentBody(body: unknown): {
  documentType?: string;
  title?: string;
  description?: string | null;
  fileReference?: string | null;
  status?: DocumentStatus;
  buildingId?: string | null;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];

  // Client/context/source are immutable after creation for BE-22A (preserve history)
  if (body.clientId !== undefined) {
    details.push({ field: 'clientId', message: 'clientId is immutable and cannot be updated.' });
  }
  if (body.contextType !== undefined) {
    details.push({ field: 'contextType', message: 'contextType is immutable and cannot be updated.' });
  }
  if (body.sourceType !== undefined) {
    details.push({ field: 'sourceType', message: 'sourceType is immutable and cannot be updated.' });
  }
  if (body.sourceId !== undefined) {
    details.push({ field: 'sourceId', message: 'sourceId is immutable and cannot be updated.' });
  }
  if (body.documentNumber !== undefined) {
    details.push({ field: 'documentNumber', message: 'documentNumber is immutable and cannot be updated.' });
  }

  const documentType =
    body.documentType === undefined
      ? undefined
      : readDocumentType(body.documentType, details, false);
  const title =
    body.title === undefined
      ? undefined
      : readRequiredString(body.title, 'title', MAX_TITLE_LENGTH, details, false);
  const description =
    body.description === null
      ? null
      : readOptionalString(body.description, 'description', MAX_DESCRIPTION_LENGTH, details);
  const fileReference =
    body.fileReference === null
      ? null
      : readOptionalString(body.fileReference, 'fileReference', MAX_FILE_REFERENCE_LENGTH, details);
  const status = body.status === undefined ? undefined : readStatus(body.status, details);
  const buildingId =
    body.buildingId === null
      ? null
      : readUuid(body.buildingId, 'buildingId', false, details);

  if (details.length > 0) fail(details);

  return {
    ...(documentType === undefined ? {} : { documentType }),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description } as { description: string | null }),
    ...(fileReference === undefined ? {} : { fileReference } as { fileReference: string | null }),
    ...(status === undefined ? {} : { status }),
    ...(buildingId === undefined ? {} : { buildingId } as { buildingId: string | null }),
  };
}

export function parseDocumentFilters(query: unknown): {
  documentType?: string;
  contextType?: DocumentContextType;
  buildingId?: string;
  status?: DocumentStatus;
  clientId?: string;
} {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  let documentType: string | undefined;
  let contextType: DocumentContextType | undefined;
  let buildingId: string | undefined;
  let status: DocumentStatus | undefined;
  let clientId: string | undefined;

  if (query.documentType !== undefined) {
    if (typeof query.documentType !== 'string' || !query.documentType.trim()) {
      details.push({ field: 'documentType', message: 'documentType must be a non-empty string.' });
    } else {
      const normalized = normalizeDocType(query.documentType);
      if (!DOCUMENT_TYPE_PATTERN.test(normalized) || normalized.length < 2) {
        details.push({ field: 'documentType', message: 'documentType is invalid.' });
      } else {
        documentType = normalized;
      }
    }
  }
  if (query.contextType !== undefined) {
    const normalized =
      typeof query.contextType === 'string' ? query.contextType.trim().toUpperCase() : query.contextType;
    if (!isDocumentContextType(normalized)) {
      details.push({ field: 'contextType', message: `contextType must be one of: ${DOCUMENT_CONTEXT_TYPES.join(', ')}.` });
    } else {
      contextType = normalized;
    }
  }
  if (query.buildingId !== undefined) {
    if (typeof query.buildingId !== 'string' || !isValidUuid(query.buildingId.trim())) {
      details.push({ field: 'buildingId', message: 'buildingId must be a valid UUID.' });
    } else {
      buildingId = query.buildingId.trim().toLowerCase();
    }
  }
  if (query.status !== undefined) {
    const normalized = typeof query.status === 'string' ? query.status.trim().toUpperCase() : query.status;
    if (!isDocumentStatus(normalized)) {
      details.push({ field: 'status', message: `status must be one of: ${DOCUMENT_STATUSES.join(', ')}.` });
    } else {
      status = normalized;
    }
  }
  if (query.clientId !== undefined) {
    if (typeof query.clientId !== 'string' || !isValidUuid(query.clientId.trim())) {
      details.push({ field: 'clientId', message: 'clientId must be a valid UUID.' });
    } else {
      clientId = query.clientId.trim().toLowerCase();
    }
  }
  if (details.length > 0) fail(details);
  return {
    ...(documentType ? { documentType } : {}),
    ...(contextType ? { contextType } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(status ? { status } : {}),
    ...(clientId ? { clientId } : {}),
  };
}
