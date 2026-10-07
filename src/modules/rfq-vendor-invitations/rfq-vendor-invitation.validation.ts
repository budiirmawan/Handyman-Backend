import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  RFQ_VENDOR_INVITATION_STATUSES,
  isRfqVendorInvitationStatus,
  type CreateRfqVendorInvitationInput,
  type ResendRfqVendorInvitationInput,
  type RfqVendorInvitationFilters,
  type RfqVendorInvitationStatus,
} from './rfq-vendor-invitation.types';
import { rfqVendorInvitationIdempotencyKeyRequiredError } from './rfq-vendor-invitation.errors';

export type ValidationDetail = { field: string; message: string };

const MAX_KEY_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function uuid(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function key(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const normalized = value.trim();
  if (normalized.length > MAX_KEY_LENGTH) {
    details.push({ field: 'idempotencyKey', message: `idempotencyKey must be at most ${MAX_KEY_LENGTH} characters.` });
    return undefined;
  }
  return normalized;
}

function resolveKey(
  body: Record<string, unknown>,
  header: unknown,
  details: ValidationDetail[],
): string {
  const value = key(typeof header === 'string' && header.trim() ? header : body.idempotencyKey, details);
  if (!value) throw rfqVendorInvitationIdempotencyKeyRequiredError();
  return value;
}

export function parseCreateRfqVendorInvitationBody(
  body: unknown,
  headerIdempotencyKey?: unknown,
): Omit<CreateRfqVendorInvitationInput, 'rfqId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: ValidationDetail[] = [];
  const vendorId = uuid(body.vendorId, 'vendorId', true, details);
  const idempotencyKey = resolveKey(body, headerIdempotencyKey, details);
  if (!vendorId || details.length) fail(details);
  return { vendorId, idempotencyKey };
}

export function parseResendRfqVendorInvitationBody(
  body: unknown,
  headerIdempotencyKey?: unknown,
): Omit<ResendRfqVendorInvitationInput, 'invitationId'> {
  if (body !== undefined && body !== null && !isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const details: ValidationDetail[] = [];
  const idempotencyKey = resolveKey(source, headerIdempotencyKey, details);
  if (details.length) fail(details);
  return { idempotencyKey };
}

export function parseRfqVendorInvitationTokenBody(body: unknown): { token: string } {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const token = body.token ?? body.invitationToken;
  if (typeof token !== 'string' || token.trim() === '') {
    fail([{ field: 'token', message: 'token is required.' }]);
  }
  return { token: (token as string).trim() };
}

export function parseRfqVendorInvitationActionBody(
  body: unknown,
): { reason: string | null } {
  if (body === undefined || body === null) return { reason: null };
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  if (body.reason === undefined || body.reason === null || body.reason === '') return { reason: null };
  if (typeof body.reason !== 'string') fail([{ field: 'reason', message: 'reason must be a string or null.' }]);
  const reason = body.reason.trim();
  if (reason.length > MAX_REASON_LENGTH) {
    fail([{ field: 'reason', message: `reason must be at most ${MAX_REASON_LENGTH} characters.` }]);
  }
  return { reason: reason || null };
}

export function parseRfqVendorInvitationIdParam(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!isValidUuid(id)) fail([{ field: 'invitationId', message: 'invitationId must be a valid UUID.' }]);
  return id;
}

export function parseRfqVendorIdParam(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!isValidUuid(id)) fail([{ field: 'vendorId', message: 'vendorId must be a valid UUID.' }]);
  return id;
}

export function parseRfqIdParam(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!isValidUuid(id)) fail([{ field: 'rfqId', message: 'rfqId must be a valid UUID.' }]);
  return id;
}

export function parseRfqVendorInvitationFilters(query: unknown): RfqVendorInvitationFilters {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return {};
  const source = query as Record<string, unknown>;
  const details: ValidationDetail[] = [];
  const vendorId = source.vendorId === undefined ? undefined : uuid(first(source.vendorId), 'vendorId', true, details);
  let status: RfqVendorInvitationStatus | undefined;
  if (source.status !== undefined) {
    const candidate = typeof first(source.status) === 'string'
      ? (first(source.status) as string).trim().toUpperCase()
      : first(source.status);
    if (!isRfqVendorInvitationStatus(candidate)) {
      details.push({ field: 'status', message: `status must be one of: ${RFQ_VENDOR_INVITATION_STATUSES.join(', ')}.` });
    } else {
      status = candidate;
    }
  }
  if (details.length) fail(details);
  return {
    ...(vendorId ? { vendorId } : {}),
    ...(status ? { status } : {}),
  };
}
