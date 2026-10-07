import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  SECURITY_VISITOR_BINDING_STATUSES,
  isSecurityVisitorBindingStatus,
  type CreateSecurityVisitorBindingInput,
  type SecurityVisitorBindingListFilters,
  type SecurityVisitorBindingStatus,
  type UpdateSecurityVisitorBindingInput,
} from './security-visitor-binding.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_REFERENCE_LENGTH = 256;
const MAX_CONTEXT_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUuidParam(
  raw: string,
  field: string,
  label: string,
): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseSecurityVisitorBindingIdParam(raw: string): string {
  return parseUuidParam(
    raw,
    'id',
    'Security visitor binding id',
  );
}

export function parseCreateSecurityVisitorBindingBody(
  body: unknown,
): Omit<CreateSecurityVisitorBindingInput, 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const securityPostId = readOptionalNullableUuid(
    body.securityPostId,
    'securityPostId',
    details,
  );
  const securityWorkforceId = readOptionalNullableUuid(
    body.securityWorkforceId,
    'securityWorkforceId',
    details,
  );
  const externalVisitReference = readRequiredReference(
    body.externalVisitReference,
    details,
  );
  const securityContext = readOptionalText(
    body.securityContext,
    'securityContext',
    MAX_CONTEXT_LENGTH,
    details,
  );
  const status = readStatus(body.status, details);

  if (!buildingId || !externalVisitReference || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId: buildingId as string,
    ...(securityPostId !== undefined ? { securityPostId } : {}),
    ...(securityWorkforceId !== undefined ? { securityWorkforceId } : {}),
    externalVisitReference,
    ...(securityContext === undefined ? {} : { securityContext }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateSecurityVisitorBindingBody(
  body: unknown,
): UpdateSecurityVisitorBindingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const input: UpdateSecurityVisitorBindingInput = {};

  const securityPostId = readOptionalNullableUuid(
    body.securityPostId,
    'securityPostId',
    details,
  );
  if (securityPostId !== undefined) {
    input.securityPostId = securityPostId;
  }

  const securityWorkforceId = readOptionalNullableUuid(
    body.securityWorkforceId,
    'securityWorkforceId',
    details,
  );
  if (securityWorkforceId !== undefined) {
    input.securityWorkforceId = securityWorkforceId;
  }

  if (
    body.externalVisitReference !== undefined &&
    body.externalVisitReference !== null &&
    body.externalVisitReference !== ''
  ) {
    const normalized = readRequiredReference(
      body.externalVisitReference,
      details,
    );
    if (normalized) {
      input.externalVisitReference = normalized;
    }
  }

  const securityContext = readOptionalText(
    body.securityContext,
    'securityContext',
    MAX_CONTEXT_LENGTH,
    details,
  );
  if (securityContext !== undefined) {
    input.securityContext = securityContext;
  }

  const status = readStatus(body.status, details);
  if (status !== undefined) {
    input.status = status;
  }

  if (Object.keys(input).length === 0) {
    details.push({
      field: 'body',
      message: 'At least one updatable field is required.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return input;
}

export function parseSecurityVisitorBindingListQuery(
  query: Record<string, unknown>,
): SecurityVisitorBindingListFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const securityPostId = readOptionalUuid(
    query.securityPostId,
    'securityPostId',
    details,
  );
  const securityWorkforceId = readOptionalUuid(
    query.securityWorkforceId,
    'securityWorkforceId',
    details,
  );
  const externalVisitReference = readOptionalReference(
    query.externalVisitReference,
    details,
  );
  const status = readStatus(query.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(securityPostId === undefined ? {} : { securityPostId }),
    ...(securityWorkforceId === undefined ? {} : { securityWorkforceId }),
    ...(externalVisitReference === undefined
      ? {}
      : { externalVisitReference }),
    ...(status === undefined ? {} : { status }),
  };
}

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}

function readRequiredUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalNullableUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readRequiredReference(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    details.push({
      field: 'externalVisitReference',
      message: 'externalVisitReference is required.',
    });
    return undefined;
  }
  return readOptionalReference(raw, details);
}

function readOptionalReference(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.length > MAX_REFERENCE_LENGTH) {
    details.push({
      field: 'externalVisitReference',
      message: `externalVisitReference must be at most ${MAX_REFERENCE_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length > max) {
    details.push({
      field,
      message: `${field} must be at most ${max} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): SecurityVisitorBindingStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isSecurityVisitorBindingStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${SECURITY_VISITOR_BINDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}
