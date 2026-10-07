import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  SHIFT_STATUSES,
  isShiftStatus,
  type CreateShiftInput,
  type ShiftStatus,
  type UpdateShiftStatusInput,
} from './shift.types';

/**
 * Shift codes are the stable machine-readable identifier (e.g. `MORNING`).
 * Normalized to uppercase, matching every other code in the system.
 */
const SHIFT_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_SHIFT_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;

/** `HH:MM` or `HH:MM:SS`, 24-hour. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export type ValidationDetail = {
  field: string;
  message: string;
};

export type CreateShiftBody = {
  clientId: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  status?: ShiftStatus;
};

export function normalizeShiftCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidShiftCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_SHIFT_CODE_LENGTH &&
    SHIFT_CODE_PATTERN.test(code)
  );
}

/**
 * Normalizes a wall-clock time to the `HH:MM:SS` form PostgreSQL TIME returns,
 * so a value written as `07:00` compares equal to the value read back.
 */
export function normalizeTime(value: string): string | null {
  const match = TIME_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  return `${match[1]}:${match[2]}:${match[3] ?? '00'}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseShiftIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'shiftId', message: 'Shift id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseShiftBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateShiftBody(
  body: unknown,
): Omit<CreateShiftInput, 'buildingId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const clientId = readClientId(body.clientId, details);
  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const startTime = readTime(body.startTime, 'startTime', details);
  const endTime = readTime(body.endTime, 'endTime', details);
  const status = readStatus(body.status, details);

  // A zero-length window is never a shift. end < start is left alone: it is a
  // legitimate overnight shift, and the Building's timezone resolves it.
  if (startTime && endTime && startTime === endTime) {
    details.push({
      field: 'endTime',
      message: 'endTime must be different from startTime.',
    });
  }

  if (!clientId || !code || !name || !startTime || !endTime || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    clientId,
    code,
    name,
    startTime,
    endTime,
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateShiftStatusBody(
  body: unknown,
): UpdateShiftStatusInput {
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
        message: `Status must be one of: ${SHIFT_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

function readClientId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'clientId',
      message: 'clientId is required and must be a valid UUID.',
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field: 'code', message: 'Code is required.' });
    return undefined;
  }

  const normalized = normalizeShiftCode(value);
  if (!isValidShiftCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Code must be 2-64 characters, start with a letter, and contain only letters, digits, hyphens, or underscores.',
    });
    return undefined;
  }

  return normalized;
}

function readName(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field: 'name', message: 'Name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readTime(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }

  const normalized = normalizeTime(value);
  if (!normalized) {
    details.push({
      field,
      message: `${field} must be a 24-hour time in HH:MM or HH:MM:SS format.`,
    });
    return undefined;
  }

  return normalized;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): ShiftStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isShiftStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${SHIFT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}
