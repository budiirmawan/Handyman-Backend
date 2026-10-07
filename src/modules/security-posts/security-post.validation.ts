import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  SECURITY_POST_STATUSES,
  SECURITY_POST_TYPES,
  isSecurityPostStatus,
  isSecurityPostType,
  type CreateSecurityPostInput,
  type SecurityPostFilter,
  type SecurityPostStatus,
  type SecurityPostType,
  type UpdateSecurityPostInput,
} from './security-post.types';

const SECURITY_POST_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeSecurityPostCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidSecurityPostCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CODE_LENGTH &&
    SECURITY_POST_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSecurityPostIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Security post id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseSecurityPostBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateSecurityPostBody(
  body: unknown,
): Omit<CreateSecurityPostInput, 'buildingId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const postType = readPostType(body.postType, details);
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const status = readStatus(body.status, details);

  const floorId = readOptionalUuid(body.floorId, 'floorId', details);
  const areaId = readOptionalUuid(body.areaId, 'areaId', details);
  const roomId = readOptionalUuid(body.roomId, 'roomId', details);
  const spaceId = readOptionalUuid(body.spaceId, 'spaceId', details);
  const functionalLocationId = readOptionalUuid(
    body.functionalLocationId,
    'functionalLocationId',
    details,
  );

  if (!code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(postType !== undefined ? { postType } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(floorId !== undefined ? { floorId } : {}),
    ...(areaId !== undefined ? { areaId } : {}),
    ...(roomId !== undefined ? { roomId } : {}),
    ...(spaceId !== undefined ? { spaceId } : {}),
    ...(functionalLocationId !== undefined ? { functionalLocationId } : {}),
  };
}

export function parseUpdateSecurityPostBody(
  body: unknown,
): UpdateSecurityPostInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name = body.name === undefined ? undefined : readName(body.name, details);
  const postType =
    body.postType === undefined ? undefined : readPostType(body.postType, details);
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

  const floorId =
    body.floorId === undefined
      ? undefined
      : readOptionalUuid(body.floorId, 'floorId', details);
  const areaId =
    body.areaId === undefined
      ? undefined
      : readOptionalUuid(body.areaId, 'areaId', details);
  const roomId =
    body.roomId === undefined
      ? undefined
      : readOptionalUuid(body.roomId, 'roomId', details);
  const spaceId =
    body.spaceId === undefined
      ? undefined
      : readOptionalUuid(body.spaceId, 'spaceId', details);
  const functionalLocationId =
    body.functionalLocationId === undefined
      ? undefined
      : readOptionalUuid(
          body.functionalLocationId,
          'functionalLocationId',
          details,
        );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(postType !== undefined ? { postType } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(floorId !== undefined ? { floorId } : {}),
    ...(areaId !== undefined ? { areaId } : {}),
    ...(roomId !== undefined ? { roomId } : {}),
    ...(spaceId !== undefined ? { spaceId } : {}),
    ...(functionalLocationId !== undefined ? { functionalLocationId } : {}),
  };
}

export function parseSecurityPostFilter(
  query: Record<string, unknown>,
): SecurityPostFilter {
  const details: ValidationDetail[] = [];

  const status =
    query.status === undefined ? undefined : readStatus(query.status, details);
  const postType =
    query.postType === undefined
      ? undefined
      : readPostType(query.postType, details);

  const floorId =
    query.floorId === undefined
      ? undefined
      : readOptionalUuid(query.floorId, 'floorId', details);
  const areaId =
    query.areaId === undefined
      ? undefined
      : readOptionalUuid(query.areaId, 'areaId', details);
  const roomId =
    query.roomId === undefined
      ? undefined
      : readOptionalUuid(query.roomId, 'roomId', details);
  const spaceId =
    query.spaceId === undefined
      ? undefined
      : readOptionalUuid(query.spaceId, 'spaceId', details);
  const functionalLocationId =
    query.functionalLocationId === undefined
      ? undefined
      : readOptionalUuid(
          query.functionalLocationId,
          'functionalLocationId',
          details,
        );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(status !== undefined ? { status } : {}),
    ...(postType !== undefined ? { postType } : {}),
    ...(floorId !== undefined && floorId !== null ? { floorId } : {}),
    ...(areaId !== undefined && areaId !== null ? { areaId } : {}),
    ...(roomId !== undefined && roomId !== null ? { roomId } : {}),
    ...(spaceId !== undefined && spaceId !== null ? { spaceId } : {}),
    ...(functionalLocationId !== undefined && functionalLocationId !== null
      ? { functionalLocationId }
      : {}),
  };
}

function readCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Security post code is required.' });
    return undefined;
  }

  const normalized = normalizeSecurityPostCode(value);
  if (!isValidSecurityPostCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Security post code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Security post name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Security post name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Security post name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readPostType(
  value: unknown,
  details: ValidationDetail[],
): SecurityPostType | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isSecurityPostType(value)) {
    details.push({
      field: 'postType',
      message: `Security post type must be one of: ${SECURITY_POST_TYPES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

function readOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
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

  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readOptionalUuid(
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

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): SecurityPostStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isSecurityPostStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${SECURITY_POST_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}
