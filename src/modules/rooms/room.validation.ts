import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ROOM_STATUSES,
  isRoomStatus,
  type CreateRoomInput,
  type RoomStatus,
  type UpdateRoomInput,
  type UpdateRoomStatusInput,
} from './room.types';

/**
 * Room codes are the stable machine-readable identifier (e.g. `R101`,
 * `MTG-A`). Normalized to uppercase, matching every other code in the
 * system: start with a letter; letters, digits, hyphens, underscores.
 */
const ROOM_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_ROOM_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidRoomCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_ROOM_CODE_LENGTH &&
    ROOM_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRoomIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'roomId', message: 'Room id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseRoomAreaIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'areaId', message: 'Area id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateRoomBody(
  body: unknown,
): Omit<CreateRoomInput, 'areaId'> {
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

export function parseUpdateRoomBody(body: unknown): UpdateRoomInput {
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
  const roomTypeId =
    body.roomTypeId === undefined
      ? undefined
      : readRoomTypeId(body.roomTypeId, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
    ...(roomTypeId === undefined ? {} : { roomTypeId }),
  };
}

/** `roomTypeId` assigns a classification; explicit null clears it. */
function readRoomTypeId(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'roomTypeId',
      message: 'roomTypeId must be a valid UUID or null.',
    });
    return undefined;
  }

  return value.trim().toLowerCase();
}

export function parseUpdateRoomStatusBody(
  body: unknown,
): UpdateRoomStatusInput {
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
        message: `Status must be one of: ${ROOM_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Room code is required.' });
    return undefined;
  }

  const normalized = normalizeRoomCode(value);
  if (!isValidRoomCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Room code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Room name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Room name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Room name must be at most ${MAX_NAME_LENGTH} characters.`,
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
): RoomStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRoomStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${ROOM_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}
