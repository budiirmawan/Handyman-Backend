import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isValidRequestType, normalizeRequestType } from '../work-requests';
import {
  TENANT_COMMUNICATION_RELATED_TYPES,
  TENANT_COMMUNICATION_STATUSES,
  isTenantCommunicationRelatedType,
  isTenantCommunicationStatus,
  type CreateTenantCommunicationInput,
  type TenantCommunicationFilters,
  type TenantCommunicationRelatedType,
  type TenantCommunicationStatus,
  type UpdateTenantCommunicationInput,
} from './tenant-communication.types';

type Detail = { field: string; message: string };
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
export const parseTenantCommunicationIdParam = (raw: string): string =>
  parseId(raw, 'tenantCommunicationId');
export const parseTenantCommunicationCompanyIdParam = (raw: string): string =>
  parseId(raw, 'tenantCompanyId');

export function parseCreateTenantCommunicationBody(
  body: unknown,
): Omit<CreateTenantCommunicationInput, 'tenantCompanyId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const buildingId = readId(body.buildingId, 'buildingId', false, details);
  const recipientTenantPicId = readId(
    body.recipientTenantPicId,
    'recipientTenantPicId',
    false,
    details,
  );
  const recipientUserId = readId(body.recipientUserId, 'recipientUserId', false, details);
  const communicationType = readCommunicationType(body.communicationType, details);
  const subject = readRequiredString(body.subject, 'subject', 255, details);
  const messageBody = readRequiredString(body.messageBody, 'messageBody', 5000, details);
  const relatedType = readRelatedType(body.relatedType, details);
  const relatedId = readId(body.relatedId, 'relatedId', false, details);
  if (!recipientTenantPicId && !recipientUserId) {
    details.push({ field: 'recipient', message: 'recipientTenantPicId or recipientUserId is required.' });
  }
  if ((relatedType === undefined) !== (relatedId === undefined)) {
    details.push({ field: relatedType ? 'relatedId' : 'relatedType', message: 'relatedType and relatedId must be supplied together.' });
  }
  if (!communicationType || !subject || !messageBody || details.length) fail(details);
  return {
    ...(buildingId ? { buildingId } : {}),
    ...(recipientTenantPicId ? { recipientTenantPicId } : {}),
    ...(recipientUserId ? { recipientUserId } : {}),
    communicationType,
    subject,
    messageBody,
    ...(relatedType ? { relatedType } : {}),
    ...(relatedId ? { relatedId } : {}),
  };
}

export function parseUpdateTenantCommunicationBody(
  body: unknown,
): UpdateTenantCommunicationInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const immutable = [
    'clientId', 'tenantCompanyId', 'buildingId', 'senderUserId',
    'recipientTenantPicId', 'recipientUserId', 'relatedType', 'relatedId',
    'status', 'sentAt', 'readAt',
  ].find((field) => body[field] !== undefined);
  if (immutable) fail([{ field: immutable, message: 'This field is immutable and cannot be updated.' }]);
  const details: Detail[] = [];
  const communicationType = body.communicationType === undefined
    ? undefined : readCommunicationType(body.communicationType, details);
  const subject = body.subject === undefined
    ? undefined : readRequiredString(body.subject, 'subject', 255, details);
  const messageBody = body.messageBody === undefined
    ? undefined : readRequiredString(body.messageBody, 'messageBody', 5000, details);
  if (details.length) fail(details);
  return {
    ...(communicationType ? { communicationType } : {}),
    ...(subject ? { subject } : {}),
    ...(messageBody ? { messageBody } : {}),
  };
}

export function parseTenantCommunicationFilters(
  query: unknown,
): TenantCommunicationFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const recipientTenantPicId = readId(query.recipientTenantPicId, 'recipientTenantPicId', false, details);
  const recipientUserId = readId(query.recipientUserId, 'recipientUserId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const communicationType = query.communicationType === undefined
    ? undefined : readCommunicationType(query.communicationType, details);
  const relatedType = readRelatedType(query.relatedType, details);
  const relatedId = readId(query.relatedId, 'relatedId', false, details);
  const status = readStatus(query.status, details);
  if (relatedId && !relatedType) {
    details.push({ field: 'relatedType', message: 'relatedType is required when filtering by relatedId.' });
  }
  if (details.length) fail(details);
  return {
    ...(recipientTenantPicId ? { recipientTenantPicId } : {}),
    ...(recipientUserId ? { recipientUserId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(communicationType ? { communicationType } : {}),
    ...(relatedType ? { relatedType } : {}),
    ...(relatedId ? { relatedId } : {}),
    ...(status ? { status } : {}),
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
function readCommunicationType(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'communicationType', message: 'communicationType is required.' });
    return undefined;
  }
  const result = normalizeRequestType(value);
  if (!isValidRequestType(result)) {
    details.push({ field: 'communicationType', message: 'communicationType must be a valid data-driven code.' });
    return undefined;
  }
  return result;
}
function readRelatedType(
  value: unknown,
  details: Detail[],
): TenantCommunicationRelatedType | undefined {
  if (value === undefined) return undefined;
  if (!isTenantCommunicationRelatedType(value)) {
    details.push({ field: 'relatedType', message: `relatedType must be one of: ${TENANT_COMMUNICATION_RELATED_TYPES.join(', ')}.` });
    return undefined;
  }
  return value;
}
function readStatus(value: unknown, details: Detail[]): TenantCommunicationStatus | undefined {
  if (value === undefined) return undefined;
  if (!isTenantCommunicationStatus(value)) {
    details.push({ field: 'status', message: `status must be one of: ${TENANT_COMMUNICATION_STATUSES.join(', ')}.` });
    return undefined;
  }
  return value;
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
