import { AppError } from '../../shared/errors';
import { isValidUuid, parseClientIdParam } from '../clients';
import {
  SKILL_CATEGORIES,
  SKILL_STATUSES,
  isSkillCategory,
  isSkillStatus,
  type CreateSkillInput,
  type SkillCategory,
  type SkillStatus,
} from './skill.types';

/**
 * Skill codes are the stable machine-readable identifier (e.g. `HVAC_L2`).
 * They follow the BE-02/BE-03 convention: normalized to uppercase, allowing
 * letters, digits, hyphens, and underscores.
 */
const SKILL_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_SKILL_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeSkillCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidSkillCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_SKILL_CODE_LENGTH &&
    SKILL_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSkillIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'skillId', message: 'Skill id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseSkillClientIdParam(raw: string): string {
  return parseClientIdParam(raw);
}

export function parseCreateSkillBody(body: unknown): Omit<CreateSkillInput, 'clientId'> {
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
  const category = readCategory(body.category, details);
  const status = readStatus(body.status, details);

  if (!code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    ...(description === undefined ? {} : { description }),
    ...(category === undefined ? {} : { category }),
    ...(status === undefined ? {} : { status }),
  };
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Skill code is required.' });
    return undefined;
  }

  const normalized = normalizeSkillCode(value);
  if (!isValidSkillCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Skill code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Skill name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Skill name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Skill name must be at most ${MAX_NAME_LENGTH} characters.`,
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

function readCategory(
  value: unknown,
  details: ValidationDetail[],
): SkillCategory | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isSkillCategory(value)) {
    details.push({
      field: 'category',
      message: `Category must be one of: ${SKILL_CATEGORIES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): SkillStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isSkillStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${SKILL_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}
