import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  SECURITY_INCIDENT_READINESS_BINDING_STATUSES,
  SECURITY_INCIDENT_READINESS_CATEGORIES,
  SECURITY_INCIDENT_READINESS_STATUSES,
  isSecurityIncidentReadinessBindingStatus,
  isSecurityIncidentReadinessCategory,
  isSecurityIncidentReadinessStatus,
  type CreateSecurityIncidentReadinessInput,
  type SecurityIncidentReadinessBindingStatus,
  type SecurityIncidentReadinessCategory,
  type SecurityIncidentReadinessListFilters,
  type SecurityIncidentReadinessStatus,
  type UpdateSecurityIncidentReadinessInput,
} from './security-incident-readiness.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

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

export function parseSecurityIncidentReadinessIdParam(raw: string): string {
  return parseUuidParam(
    raw,
    'id',
    'Security incident readiness id',
  );
}

export function parseCreateSecurityIncidentReadinessBody(
  body: unknown,
): Omit<CreateSecurityIncidentReadinessInput, 'createdByUserId'> {
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

  let category: SecurityIncidentReadinessCategory | undefined;
  const rawCategory = readSingleParam(body.category);
  if (rawCategory === undefined || rawCategory === '') {
    details.push({ field: 'category', message: 'category is required.' });
  } else {
    const normalized = rawCategory.trim().toUpperCase();
    if (!isSecurityIncidentReadinessCategory(normalized)) {
      details.push({
        field: 'category',
        message: `category must be one of: ${SECURITY_INCIDENT_READINESS_CATEGORIES.join(', ')}.`,
      });
    } else {
      category = normalized;
    }
  }

  const readinessStatus = readReadinessStatus(body.readinessStatus, details);
  const status = readBindingStatus(body.status, details);
  const responsibleTeamId = readOptionalNullableUuid(
    body.responsibleTeamId,
    'responsibleTeamId',
    details,
  );
  const responsibleWorkforceId = readOptionalNullableUuid(
    body.responsibleWorkforceId,
    'responsibleWorkforceId',
    details,
  );
  const evidenceRequirementId = readOptionalNullableUuid(
    body.evidenceRequirementId,
    'evidenceRequirementId',
    details,
  );
  const escalationContact = readOptionalText(
    body.escalationContact,
    'escalationContact',
    256,
    details,
  );
  const reportingInstructions = readOptionalText(
    body.reportingInstructions,
    'reportingInstructions',
    4096,
    details,
  );
  const notes = readOptionalText(body.notes, 'notes', 4096, details);

  if (!buildingId || !category || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId: buildingId as string,
    ...(securityPostId !== undefined ? { securityPostId } : {}),
    category: category as SecurityIncidentReadinessCategory,
    ...(readinessStatus === undefined ? {} : { readinessStatus }),
    ...(status === undefined ? {} : { status }),
    ...(responsibleTeamId === undefined ? {} : { responsibleTeamId }),
    ...(responsibleWorkforceId === undefined
      ? {}
      : { responsibleWorkforceId }),
    ...(evidenceRequirementId === undefined
      ? {}
      : { evidenceRequirementId }),
    ...(escalationContact === undefined ? {} : { escalationContact }),
    ...(reportingInstructions === undefined
      ? {}
      : { reportingInstructions }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseUpdateSecurityIncidentReadinessBody(
  body: unknown,
): UpdateSecurityIncidentReadinessInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const input: UpdateSecurityIncidentReadinessInput = {};

  const securityPostId = readOptionalNullableUuid(
    body.securityPostId,
    'securityPostId',
    details,
  );
  if (securityPostId !== undefined) {
    input.securityPostId = securityPostId;
  }

  const rawCategory = readSingleParam(body.category);
  if (rawCategory !== undefined && rawCategory !== '') {
    const normalized = rawCategory.trim().toUpperCase();
    if (!isSecurityIncidentReadinessCategory(normalized)) {
      details.push({
        field: 'category',
        message: `category must be one of: ${SECURITY_INCIDENT_READINESS_CATEGORIES.join(', ')}.`,
      });
    } else {
      input.category = normalized as SecurityIncidentReadinessCategory;
    }
  }

  const readinessStatus = readReadinessStatus(body.readinessStatus, details);
  if (readinessStatus !== undefined) {
    input.readinessStatus = readinessStatus;
  }

  const status = readBindingStatus(body.status, details);
  if (status !== undefined) {
    input.status = status;
  }

  const responsibleTeamId = readOptionalNullableUuid(
    body.responsibleTeamId,
    'responsibleTeamId',
    details,
  );
  if (responsibleTeamId !== undefined) {
    input.responsibleTeamId = responsibleTeamId;
  }

  const responsibleWorkforceId = readOptionalNullableUuid(
    body.responsibleWorkforceId,
    'responsibleWorkforceId',
    details,
  );
  if (responsibleWorkforceId !== undefined) {
    input.responsibleWorkforceId = responsibleWorkforceId;
  }

  const evidenceRequirementId = readOptionalNullableUuid(
    body.evidenceRequirementId,
    'evidenceRequirementId',
    details,
  );
  if (evidenceRequirementId !== undefined) {
    input.evidenceRequirementId = evidenceRequirementId;
  }

  const escalationContact = readOptionalText(
    body.escalationContact,
    'escalationContact',
    256,
    details,
  );
  if (escalationContact !== undefined) {
    input.escalationContact = escalationContact;
  }

  const reportingInstructions = readOptionalText(
    body.reportingInstructions,
    'reportingInstructions',
    4096,
    details,
  );
  if (reportingInstructions !== undefined) {
    input.reportingInstructions = reportingInstructions;
  }

  const notes = readOptionalText(body.notes, 'notes', 4096, details);
  if (notes !== undefined) {
    input.notes = notes;
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

export function parseSecurityIncidentReadinessListQuery(
  query: Record<string, unknown>,
): SecurityIncidentReadinessListFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const securityPostId = readOptionalUuid(
    query.securityPostId,
    'securityPostId',
    details,
  );

  let category: SecurityIncidentReadinessCategory | undefined;
  const rawCategory = readSingleParam(query.category);
  if (rawCategory !== undefined && rawCategory !== '') {
    const normalized = rawCategory.trim().toUpperCase();
    if (!isSecurityIncidentReadinessCategory(normalized)) {
      details.push({
        field: 'category',
        message: `category must be one of: ${SECURITY_INCIDENT_READINESS_CATEGORIES.join(', ')}.`,
      });
    } else {
      category = normalized;
    }
  }

  const readinessStatus = readReadinessStatus(query.readinessStatus, details);
  const status = readBindingStatus(query.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(securityPostId === undefined ? {} : { securityPostId }),
    ...(category === undefined ? {} : { category }),
    ...(readinessStatus === undefined ? {} : { readinessStatus }),
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

function readReadinessStatus(
  value: unknown,
  details: ValidationDetail[],
): SecurityIncidentReadinessStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isSecurityIncidentReadinessStatus(value)) {
    details.push({
      field: 'readinessStatus',
      message: `readinessStatus must be one of: ${SECURITY_INCIDENT_READINESS_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readBindingStatus(
  value: unknown,
  details: ValidationDetail[],
): SecurityIncidentReadinessBindingStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isSecurityIncidentReadinessBindingStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${SECURITY_INCIDENT_READINESS_BINDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}
