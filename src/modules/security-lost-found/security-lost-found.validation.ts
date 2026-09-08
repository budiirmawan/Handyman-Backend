import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  SECURITY_LOST_FOUND_STATUSES,
  isSecurityLostFoundStatus,
  type CreateSecurityLostFoundInput,
  type RegisterClaimInput,
  type SecurityLostFoundListFilters,
  type SecurityLostFoundStatus,
  type UpdateSecurityLostFoundInput,
} from './security-lost-found.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_ITEM_CODE_LENGTH = 64;
const MAX_ITEM_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_NOTES_LENGTH = 4096;
const MAX_CLAIMANT_NAME_LENGTH = 160;
const MAX_CLAIMANT_REFERENCE_LENGTH = 160;
const MAX_CLAIM_NOTES_LENGTH = 4096;
const ITEM_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;

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

export function parseSecurityLostFoundIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Security lost & found id');
}

export function normalizeItemCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidItemCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_ITEM_CODE_LENGTH &&
    ITEM_CODE_PATTERN.test(code)
  );
}

export function parseCreateSecurityLostFoundBody(
  body: unknown,
): Omit<CreateSecurityLostFoundInput, 'foundByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const itemCode = readItemCode(body.itemCode, details);
  const itemName = readItemName(body.itemName, details);
  const description = readOptionalText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const securityPostId = readOptionalNullableUuid(
    body.securityPostId,
    'securityPostId',
    details,
  );
  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    details,
  );
  const foundAt = readOptionalDate(body.foundAt, 'foundAt', details);
  const notes = readOptionalText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (!buildingId || !itemCode || !itemName || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId: buildingId as string,
    itemCode,
    itemName,
    ...(description === undefined ? {} : { description }),
    ...(securityPostId === undefined ? {} : { securityPostId }),
    ...(functionalLocationId === undefined
      ? {}
      : { functionalLocationId }),
    ...(foundAt === undefined ? {} : { foundAt }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseUpdateSecurityLostFoundBody(
  body: unknown,
): UpdateSecurityLostFoundInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const input: UpdateSecurityLostFoundInput = {};

  const itemName = body.itemName === undefined ? undefined : readItemName(body.itemName, details);
  if (itemName !== undefined) {
    input.itemName = itemName;
  }

  const description = readOptionalText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  if (description !== undefined) {
    input.description = description;
  }

  const securityPostId = readOptionalNullableUuid(
    body.securityPostId,
    'securityPostId',
    details,
  );
  if (securityPostId !== undefined) {
    input.securityPostId = securityPostId;
  }

  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    details,
  );
  if (functionalLocationId !== undefined) {
    input.functionalLocationId = functionalLocationId;
  }

  const notes = readOptionalText(body.notes, 'notes', MAX_NOTES_LENGTH, details);
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

export function parseSecurityLostFoundListQuery(
  query: Record<string, unknown>,
): SecurityLostFoundListFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const securityPostId = readOptionalUuid(
    query.securityPostId,
    'securityPostId',
    details,
  );
  const custodyStatus = readStatus(query.custodyStatus, details);
  const fromDate = readOptionalQueryDate(query.fromDate, 'fromDate', details);
  const toDate = readOptionalQueryDate(query.toDate, 'toDate', details);

  if (fromDate && toDate) {
    if (new Date(fromDate).getTime() > new Date(toDate).getTime()) {
      details.push({
        field: 'fromDate',
        message: 'fromDate must be earlier than or equal to toDate.',
      });
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(securityPostId === undefined ? {} : { securityPostId }),
    ...(custodyStatus === undefined ? {} : { custodyStatus }),
    ...(fromDate === undefined ? {} : { fromDate }),
    ...(toDate === undefined ? {} : { toDate }),
  };
}

export function parsePlaceCustodyBody(
  body: unknown,
): { notes: string | null } {
  if (body === undefined || body === null) {
    return { notes: null };
  }
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: ValidationDetail[] = [];
  const notes = readOptionalText(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return notes === undefined ? { notes: null } : { notes };
}

export function parseRegisterClaimBody(
  body: unknown,
): Omit<RegisterClaimInput, 'lostFoundId' | 'actorUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const claimantName = readRequiredText(
    body.claimantName,
    'claimantName',
    MAX_CLAIMANT_NAME_LENGTH,
    details,
  );
  const claimantReference = readOptionalText(
    body.claimantReference,
    'claimantReference',
    MAX_CLAIMANT_REFERENCE_LENGTH,
    details,
  );
  const claimNotes = readOptionalText(
    body.claimNotes,
    'claimNotes',
    MAX_CLAIM_NOTES_LENGTH,
    details,
  );
  const notes = readOptionalText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (!claimantName || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    claimantName,
    ...(claimantReference === undefined ? {} : { claimantReference }),
    ...(claimNotes === undefined ? {} : { claimNotes }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseReturnBody(body: unknown): {
  returnedByUserId: string;
  notes: string | null;
} {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: ValidationDetail[] = [];
  const returnedByUserId = readRequiredUuid(
    body.returnedByUserId,
    'returnedByUserId',
    details,
  );
  const notes = readOptionalText(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!returnedByUserId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    returnedByUserId: returnedByUserId as string,
    notes: notes ?? null,
  };
}

export function parseCloseBody(body: unknown): { notes: string | null } {
  if (body === undefined || body === null) {
    return { notes: null };
  }
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: ValidationDetail[] = [];
  const notes = readOptionalText(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return notes === undefined ? { notes: null } : { notes };
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

function readItemCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    details.push({ field: 'itemCode', message: 'itemCode is required.' });
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'itemCode', message: 'itemCode must be a string.' });
    return undefined;
  }
  const normalized = normalizeItemCode(value);
  if (!isValidItemCode(normalized)) {
    details.push({
      field: 'itemCode',
      message:
        'itemCode must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }
  return normalized;
}

function readItemName(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'itemName', message: 'itemName is required.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'itemName', message: 'itemName is required.' });
    return undefined;
  }
  if (trimmed.length > MAX_ITEM_NAME_LENGTH) {
    details.push({
      field: 'itemName',
      message: `itemName must be at most ${MAX_ITEM_NAME_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
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

function readOptionalDate(
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
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  return parsed.toISOString();
}

/**
 * Query-string variant of `readOptionalDate`. Treats an empty string
 * the same as `undefined` (so callers can use a single helper for
 * optional query params). Returns `string | undefined` only (never
 * `null`) — query strings have no meaningful `null` representation.
 */
function readOptionalQueryDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  return parsed.toISOString();
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): SecurityLostFoundStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isSecurityLostFoundStatus(value)) {
    details.push({
      field: 'custodyStatus',
      message: `custodyStatus must be one of: ${SECURITY_LOST_FOUND_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}
