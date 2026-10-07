import { AppError } from '../../shared/errors';
import {
  WORKFORCE_STATUSES,
  WORKFORCE_TYPES,
  isWorkforceStatus,
  isWorkforceType,
  type WorkforceStatus,
  type WorkforceType,
} from './workforce.types';

const EMPLOYEE_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_EMPLOYEE_CODE_LENGTH = 64;
const MAX_FULL_NAME_LENGTH = 160;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeEmployeeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidEmployeeCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_EMPLOYEE_CODE_LENGTH &&
    EMPLOYEE_CODE_PATTERN.test(code)
  );
}

export function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
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

export function parseWorkforceProfileIdParam(raw: string): string {
  return parseUuidParam(raw, 'workforceProfileId', 'Workforce profile id');
}

export function parseOrganizationIdParam(raw: string): string {
  return parseUuidParam(raw, 'organizationId', 'Organization id');
}

export function parseDepartmentIdParam(raw: string): string {
  return parseUuidParam(raw, 'departmentId', 'Department id');
}

export function parseTeamIdParam(raw: string): string {
  return parseUuidParam(raw, 'teamId', 'Team id');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface CreateWorkforceProfileBody {
  departmentId: string;
  teamId?: string | null;
  positionId: string;
  userId?: string | null;
  employeeCode: string;
  fullName: string;
  workforceType?: WorkforceType;
  status?: WorkforceStatus;
}

export interface UpdateWorkforceProfileBody {
  departmentId?: string;
  teamId?: string | null;
  positionId?: string;
  userId?: string | null;
  fullName?: string;
  workforceType?: WorkforceType;
  status?: WorkforceStatus;
}

export function parseCreateWorkforceProfileBody(
  body: unknown,
): CreateWorkforceProfileBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const departmentId = readRequiredUuid(
    body.departmentId,
    'departmentId',
    'Department id',
    details,
  );
  const positionId = readRequiredUuid(
    body.positionId,
    'positionId',
    'Position id',
    details,
  );
  const teamId = readNullableUuid(body.teamId, 'teamId', 'Team id', details);
  const userId = readNullableUuid(body.userId, 'userId', 'User id', details);
  const employeeCode = readEmployeeCode(body.employeeCode, details);
  const fullName = readFullName(body.fullName, details);
  const workforceType = readWorkforceType(body.workforceType, details);
  const status = readStatus(body.status, details);

  if (!departmentId || !positionId || !employeeCode || !fullName || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    departmentId,
    positionId,
    employeeCode,
    fullName,
    ...(teamId === undefined ? {} : { teamId }),
    ...(userId === undefined ? {} : { userId }),
    ...(workforceType === undefined ? {} : { workforceType }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateWorkforceProfileBody(
  body: unknown,
): UpdateWorkforceProfileBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const departmentId =
    body.departmentId === undefined
      ? undefined
      : readRequiredUuid(body.departmentId, 'departmentId', 'Department id', details);
  const positionId =
    body.positionId === undefined
      ? undefined
      : readRequiredUuid(body.positionId, 'positionId', 'Position id', details);
  const teamId =
    body.teamId === undefined
      ? undefined
      : readNullableUuid(body.teamId, 'teamId', 'Team id', details);
  const userId =
    body.userId === undefined
      ? undefined
      : readNullableUuid(body.userId, 'userId', 'User id', details);
  const fullName =
    body.fullName === undefined ? undefined : readFullName(body.fullName, details);
  const workforceType =
    body.workforceType === undefined
      ? undefined
      : readWorkforceType(body.workforceType, details);
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(departmentId === undefined ? {} : { departmentId }),
    ...(positionId === undefined ? {} : { positionId }),
    ...(teamId === undefined ? {} : { teamId }),
    ...(userId === undefined ? {} : { userId }),
    ...(fullName === undefined ? {} : { fullName }),
    ...(workforceType === undefined ? {} : { workforceType }),
    ...(status === undefined ? {} : { status }),
  };
}

function readRequiredUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return value.toLowerCase();
}

/**
 * Reads an optional UUID that also accepts an explicit `null` — used for
 * `teamId` and `userId`, where `null` deliberately means "unassigned"
 * (a Workforce Profile can exist with no Team and with no User account).
 */
function readNullableUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !isValidUuid(value)) {
    details.push({ field, message: `${label} must be a valid UUID or null.` });
    return undefined;
  }
  return value.toLowerCase();
}

function readEmployeeCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'employeeCode', message: 'Employee code is required.' });
    return undefined;
  }

  const normalized = normalizeEmployeeCode(value);
  if (!isValidEmployeeCode(normalized)) {
    details.push({
      field: 'employeeCode',
      message:
        'Employee code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readFullName(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'fullName', message: 'Full name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'fullName', message: 'Full name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_FULL_NAME_LENGTH) {
    details.push({
      field: 'fullName',
      message: `Full name must be at most ${MAX_FULL_NAME_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readWorkforceType(
  value: unknown,
  details: ValidationDetail[],
): WorkforceType | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isWorkforceType(value)) {
    details.push({
      field: 'workforceType',
      message: `Workforce type must be one of: ${WORKFORCE_TYPES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): WorkforceStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isWorkforceStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${WORKFORCE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}
