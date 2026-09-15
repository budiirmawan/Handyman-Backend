import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HANDYMAN_INBOUND_CHANNELS,
  HANDYMAN_OPERATIONAL_SURFACES,
  HANDYMAN_REQUEST_PRIORITIES,
  HANDYMAN_REQUEST_STATUSES,
  isHandymanInboundChannel,
  isHandymanOperationalSurface,
  isHandymanRequestPriority,
  isHandymanRequestStatus,
  type CreateHandymanRequestInput,
  type HandymanInboundChannel,
  type HandymanOperationalSurface,
  type HandymanRequestFilters,
  type HandymanRequestPriority,
  type HandymanRequestStatus,
} from './handyman-request.types';

type Detail = { field: string; message: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9()\-\s.]{5,}$/;
const MAX_STRING_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_EMAIL_LENGTH = 254;
const MAX_PHONE_LENGTH = 50;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function readRequiredUuid(
  value: unknown,
  field: string,
  details: Detail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readRequiredString(
  value: unknown,
  field: string,
  maxLength: number,
  details: Detail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    details.push({ field, message: `${field} cannot be empty.` });
    return undefined;
  }
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalPhone(
  value: unknown,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    details.push({ field: 'customerPhone', message: 'customerPhone must be a string.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_PHONE_LENGTH || !PHONE_PATTERN.test(trimmed)) {
    details.push({ field: 'customerPhone', message: 'customerPhone has an invalid format.' });
    return undefined;
  }
  return trimmed;
}

function readOptionalEmail(
  value: unknown,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    details.push({ field: 'customerEmail', message: 'customerEmail must be a string.' });
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(trimmed)) {
    details.push({ field: 'customerEmail', message: 'customerEmail has an invalid format.' });
    return undefined;
  }
  return trimmed;
}

function readInboundChannel(
  value: unknown,
  details: Detail[],
): HandymanInboundChannel | undefined {
  if (value === undefined || value === null || value === '') {
    details.push({ field: 'inboundChannel', message: 'inboundChannel is required.' });
    return undefined;
  }
  if (!isHandymanInboundChannel(value)) {
    details.push({
      field: 'inboundChannel',
      message: `inboundChannel must be one of: ${HANDYMAN_INBOUND_CHANNELS.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readPriority(
  value: unknown,
  details: Detail[],
): HandymanRequestPriority | undefined {
  if (value === undefined || value === null || value === '') {
    return 'MEDIUM';
  }
  if (!isHandymanRequestPriority(value)) {
    details.push({
      field: 'priority',
      message: `priority must be one of: ${HANDYMAN_REQUEST_PRIORITIES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readOperationalSurface(
  value: unknown,
  details: Detail[],
): HandymanOperationalSurface | undefined {
  if (value === undefined || value === null || value === '') {
    return 'BM_SUPER_APP';
  }
  if (!isHandymanOperationalSurface(value)) {
    details.push({
      field: 'operationalSurface',
      message: `operationalSurface must be one of: ${HANDYMAN_OPERATIONAL_SURFACES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readDate(
  value: unknown,
  field: string,
  details: Detail[],
): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      details.push({ field, message: `${field} must be a valid date.` });
      return undefined;
    }
    return value;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a valid ISO 8601 date string.` });
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be a valid ISO 8601 date string.` });
    return undefined;
  }
  return parsed;
}

export function parseHandymanRequestIdParam(raw: string): string {
  if (typeof raw !== 'string') {
    fail([{ field: 'id', message: 'Handyman request id must be a string.' }]);
  }
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'id', message: 'Handyman request id must be a valid UUID.' }]);
  }
  return value;
}

export const validateHandymanRequestIdParam = parseHandymanRequestIdParam;

export function parseCreateHandymanRequestBody(body: unknown): CreateHandymanRequestInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: Detail[] = [];

  // Reject caller-supplied server-managed fields
  if (body.requestNumber !== undefined) {
    details.push({
      field: 'requestNumber',
      message: 'requestNumber is server-generated and cannot be provided.',
    });
  }
  if (body.status !== undefined) {
    details.push({
      field: 'status',
      message: 'status is server-managed and cannot be provided on creation.',
    });
  }
  if (body.createdByUserId !== undefined) {
    details.push({
      field: 'createdByUserId',
      message: 'createdByUserId is derived from authenticated context and cannot be provided.',
    });
  }

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const spaceId = readRequiredUuid(body.spaceId, 'spaceId', details);
  const tenantCompanyId = readOptionalUuid(body.tenantCompanyId, 'tenantCompanyId', details);
  const tenantPicId = readOptionalUuid(body.tenantPicId, 'tenantPicId', details);
  const customerName = readRequiredString(body.customerName, 'customerName', MAX_STRING_LENGTH, details);
  const customerPhone = readOptionalPhone(body.customerPhone, details);
  const customerEmail = readOptionalEmail(body.customerEmail, details);
  const operationalSurface = readOperationalSurface(body.operationalSurface, details);
  const inboundChannel = readInboundChannel(body.inboundChannel, details);
  const title = readRequiredString(body.title, 'title', MAX_STRING_LENGTH, details);
  const description = readOptionalString(body.description, 'description', MAX_DESCRIPTION_LENGTH, details);
  const priority = readPriority(body.priority, details);
  const idempotencyKey = readOptionalString(body.idempotencyKey, 'idempotencyKey', MAX_IDEMPOTENCY_KEY_LENGTH, details);
  const requestedAt = readDate(body.requestedAt, 'requestedAt', details);

  if (details.length > 0 || !buildingId || !spaceId || !customerName || !inboundChannel || !title) {
    fail(details);
  }

  return {
    buildingId,
    spaceId,
    tenantCompanyId: tenantCompanyId ?? null,
    tenantPicId: tenantPicId ?? null,
    customerName,
    customerPhone: customerPhone ?? null,
    customerEmail: customerEmail ?? null,
    operationalSurface: operationalSurface ?? 'BM_SUPER_APP',
    inboundChannel,
    title,
    description: description ?? null,
    priority: priority ?? 'MEDIUM',
    idempotencyKey: idempotencyKey ?? null,
    requestedAt: requestedAt ?? null,
  };
}

export const validateCreateHandymanRequestInput = parseCreateHandymanRequestBody;

export function parseHandymanRequestFilters(query: unknown): HandymanRequestFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];

  const buildingId = query.buildingId !== undefined
    ? readOptionalUuid(query.buildingId, 'buildingId', details) ?? undefined
    : undefined;

  const spaceId = query.spaceId !== undefined
    ? readOptionalUuid(query.spaceId, 'spaceId', details) ?? undefined
    : undefined;

  let status: HandymanRequestStatus | undefined;
  if (query.status !== undefined && query.status !== '') {
    if (!isHandymanRequestStatus(query.status)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${HANDYMAN_REQUEST_STATUSES.join(', ')}.`,
      });
    } else {
      status = query.status;
    }
  }

  let inboundChannel: HandymanInboundChannel | undefined;
  if (query.inboundChannel !== undefined && query.inboundChannel !== '') {
    if (!isHandymanInboundChannel(query.inboundChannel)) {
      details.push({
        field: 'inboundChannel',
        message: `inboundChannel must be one of: ${HANDYMAN_INBOUND_CHANNELS.join(', ')}.`,
      });
    } else {
      inboundChannel = query.inboundChannel;
    }
  }

  const createdByUserId = query.createdByUserId !== undefined
    ? readOptionalUuid(query.createdByUserId, 'createdByUserId', details) ?? undefined
    : undefined;

  const tenantCompanyId = query.tenantCompanyId !== undefined
    ? readOptionalUuid(query.tenantCompanyId, 'tenantCompanyId', details) ?? undefined
    : undefined;

  let search: string | undefined;
  if (query.search !== undefined && query.search !== '') {
    if (typeof query.search !== 'string') {
      details.push({ field: 'search', message: 'search must be a string.' });
    } else {
      search = query.search.trim() || undefined;
    }
  }

  let limit: number | undefined;
  if (query.limit !== undefined && query.limit !== '') {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      details.push({ field: 'limit', message: 'limit must be a positive integer.' });
    } else {
      limit = Math.min(parsed, 100);
    }
  }

  let offset: number | undefined;
  if (query.offset !== undefined && query.offset !== '') {
    const parsed = Number(query.offset);
    if (!Number.isInteger(parsed) || parsed < 0) {
      details.push({ field: 'offset', message: 'offset must be a non-negative integer.' });
    } else {
      offset = parsed;
    }
  }

  if (details.length > 0) {
    fail(details);
  }

  return {
    ...(buildingId ? { buildingId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(status ? { status } : {}),
    ...(inboundChannel ? { inboundChannel } : {}),
    ...(createdByUserId ? { createdByUserId } : {}),
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    ...(search ? { search } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  };
}

export const validateHandymanRequestFilters = parseHandymanRequestFilters;
