import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  FINDING_STATUSES,
  isFindingStatus,
} from '../findings/finding.types';
import {
  SECURITY_FINDING_SOURCE_TYPES,
  isSecurityFindingSourceType,
  type CreateSecurityFindingInput,
  type SecurityFindingListFilters,
  type SecurityFindingSourceType,
} from './security-finding.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const ASSIGNEE_TYPES = [
  'WORKFORCE',
  'TEAM',
  'VENDOR',
  'VENDOR_WORKFORCE',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUuidParam(raw: string, field: string, label: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseSecurityFindingIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Security finding id');
}

export function parseCreateSecurityFindingBody(
  body: unknown,
): Omit<CreateSecurityFindingInput, 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);

  let sourceType: SecurityFindingSourceType | undefined;
  const rawSourceType = readSingleParam(body.sourceType);
  if (rawSourceType === undefined || rawSourceType === '') {
    details.push({ field: 'sourceType', message: 'sourceType is required.' });
  } else {
    const normalized = rawSourceType.trim().toUpperCase();
    if (!isSecurityFindingSourceType(normalized)) {
      details.push({
        field: 'sourceType',
        message: `sourceType must be one of: ${SECURITY_FINDING_SOURCE_TYPES.join(', ')}.`,
      });
    } else {
      sourceType = normalized;
    }
  }

  const sourceId = readRequiredUuid(body.sourceId, 'sourceId', details);

  const startSecurityPostId = readOptionalNullableUuid(
    body.startSecurityPostId,
    'startSecurityPostId',
    details,
  );
  const patrolRouteId = readOptionalNullableUuid(
    body.patrolRouteId,
    'patrolRouteId',
    details,
  );

  const title = readRequiredText(body.title, 'title', 160, details);
  const description = readOptionalText(
    body.description,
    'description',
    2048,
    details,
  );

  const classificationId = readOptionalUuid(
    body.classificationId,
    'classificationId',
    details,
  );
  const severityId = readOptionalUuid(body.severityId, 'severityId', details);

  let assigneeType: CreateSecurityFindingInput['assigneeType'];
  const rawAssigneeType = readSingleParam(body.assigneeType);
  if (rawAssigneeType !== undefined && rawAssigneeType !== '') {
    const normalized = rawAssigneeType.trim().toUpperCase();
    if (!(ASSIGNEE_TYPES as readonly string[]).includes(normalized)) {
      details.push({
        field: 'assigneeType',
        message: `assigneeType must be one of: ${ASSIGNEE_TYPES.join(', ')}.`,
      });
    } else {
      assigneeType = normalized as CreateSecurityFindingInput['assigneeType'];
    }
  }
  const workforceProfileId = readOptionalUuid(
    body.workforceProfileId,
    'workforceProfileId',
    details,
  );
  const teamId = readOptionalUuid(body.teamId, 'teamId', details);
  const vendorId = readOptionalUuid(body.vendorId, 'vendorId', details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId: buildingId as string,
    sourceType: sourceType as SecurityFindingSourceType,
    sourceId: sourceId as string,
    ...(startSecurityPostId !== undefined ? { startSecurityPostId } : {}),
    ...(patrolRouteId !== undefined ? { patrolRouteId } : {}),
    title: title as string,
    ...(description === undefined ? {} : { description }),
    ...(classificationId === undefined ? {} : { classificationId }),
    ...(severityId === undefined ? {} : { severityId }),
    ...(assigneeType === undefined ? {} : { assigneeType }),
    ...(workforceProfileId === undefined ? {} : { workforceProfileId }),
    ...(teamId === undefined ? {} : { teamId }),
    ...(vendorId === undefined ? {} : { vendorId }),
  };
}

export function parseListSecurityFindingsQuery(
  query: Record<string, unknown>,
): SecurityFindingListFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);

  let startSecurityPostId: string | undefined;
  const rawPost = readSingleParam(query.startSecurityPostId);
  if (rawPost !== undefined && rawPost !== '') {
    if (!isValidUuid(rawPost.trim())) {
      details.push({
        field: 'startSecurityPostId',
        message: 'startSecurityPostId must be a valid UUID.',
      });
    } else {
      startSecurityPostId = rawPost.trim().toLowerCase();
    }
  }

  let patrolRouteId: string | undefined;
  const rawRoute = readSingleParam(query.patrolRouteId);
  if (rawRoute !== undefined && rawRoute !== '') {
    if (!isValidUuid(rawRoute.trim())) {
      details.push({
        field: 'patrolRouteId',
        message: 'patrolRouteId must be a valid UUID.',
      });
    } else {
      patrolRouteId = rawRoute.trim().toLowerCase();
    }
  }

  let sourceType: SecurityFindingSourceType | undefined;
  const rawSourceType = readSingleParam(query.sourceType);
  if (rawSourceType !== undefined && rawSourceType !== '') {
    const normalized = rawSourceType.trim().toUpperCase();
    if (!isSecurityFindingSourceType(normalized)) {
      details.push({
        field: 'sourceType',
        message: `sourceType must be one of: ${SECURITY_FINDING_SOURCE_TYPES.join(', ')}.`,
      });
    } else {
      sourceType = normalized;
    }
  }

  let status: string | undefined;
  const rawStatus = readSingleParam(query.status);
  if (rawStatus !== undefined && rawStatus !== '') {
    const normalized = rawStatus.trim().toUpperCase();
    if (!isFindingStatus(normalized)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${FINDING_STATUSES.join(', ')}.`,
      });
    } else {
      status = normalized;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(startSecurityPostId === undefined ? {} : { startSecurityPostId }),
    ...(patrolRouteId === undefined ? {} : { patrolRouteId }),
    ...(sourceType === undefined ? {} : { sourceType }),
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

function readRequiredText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
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

function readOptionalText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const text = raw.trim();
  if (text.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return text;
}
