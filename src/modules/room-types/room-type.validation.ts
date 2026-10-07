import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ROOM_TYPE_STATUSES,
  isRoomTypeStatus,
  type CreateRoomTypeInput,
  type RoomTypeStatus,
  type UpdateRoomTypeInput,
  type UpdateRoomTypeStatusInput,
} from './room-type.types';

/**
 * Room Type codes are the stable machine-readable identifier (e.g. `OFFICE`,
 * `MEETING_ROOM`, `ELECTRICAL_ROOM`). Normalized to uppercase, matching
 * every other code in the system: start with a letter; letters, digits,
 * hyphens, underscores. Codes are reference DATA — never behavior.
 */
const ROOM_TYPE_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_ROOM_TYPE_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeRoomTypeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidRoomTypeCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_ROOM_TYPE_CODE_LENGTH &&
    ROOM_TYPE_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRoomTypeIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'roomTypeId', message: 'Room type id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseRoomTypeClientIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'Client id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateRoomTypeBody(
  body: unknown,
): Omit<CreateRoomTypeInput, 'clientId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const status = readStatus(body.status, details);

  if (!code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateRoomTypeBody(body: unknown): UpdateRoomTypeInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name = body.name === undefined ? undefined : readName(body.name, details);
  const description =
    body.description === undefined
      ? undefined
      : readOptionalString(
          body.description,
          'description',
          MAX_DESCRIPTION_LENGTH,
          details,
        );
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateRoomTypeStatusBody(
  body: unknown,
): UpdateRoomTypeStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const status = readStatus(body.status, []);
  if (!status) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${ROOM_TYPE_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Room type code is required.' });
    return undefined;
  }

  const normalized = normalizeRoomTypeCode(value);
  if (!isValidRoomTypeCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Room type code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Room type name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Room type name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Room type name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
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

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): RoomTypeStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRoomTypeStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${ROOM_TYPE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}
