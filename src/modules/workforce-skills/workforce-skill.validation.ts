import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  PROFICIENCY_LEVELS,
  WORKFORCE_SKILL_STATUSES,
  isProficiencyLevel,
  isWorkforceSkillStatus,
  type ProficiencyLevel,
  type WorkforceSkillStatus,
} from './workforce-skill.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

export type AssignWorkforceSkillBody = {
  skillId: string;
  proficiencyLevel?: ProficiencyLevel;
  validFrom?: Date | null;
  validUntil?: Date | null;
  status?: WorkforceSkillStatus;
};

export type UpdateWorkforceSkillBody = {
  proficiencyLevel?: ProficiencyLevel;
  validFrom?: Date | null;
  validUntil?: Date | null;
  status?: WorkforceSkillStatus;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorkforceIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'workforceId', message: 'Workforce id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
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

export function parseAssignWorkforceSkillBody(
  body: unknown,
): AssignWorkforceSkillBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const skillId = readSkillId(body.skillId, details);
  const proficiencyLevel = readProficiencyLevel(body.proficiencyLevel, details);
  const validFrom = readOptionalDate(body.validFrom, 'validFrom', details);
  const validUntil = readOptionalDate(body.validUntil, 'validUntil', details);
  const status = readStatus(body.status, details);

  assertValidityOrder(validFrom, validUntil, details);

  if (!skillId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    skillId,
    ...(proficiencyLevel === undefined ? {} : { proficiencyLevel }),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateWorkforceSkillBody(
  body: unknown,
): UpdateWorkforceSkillBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const proficiencyLevel = readProficiencyLevel(body.proficiencyLevel, details);
  const validFrom = readOptionalDate(body.validFrom, 'validFrom', details);
  const validUntil = readOptionalDate(body.validUntil, 'validUntil', details);
  const status = readStatus(body.status, details);

  // Only checkable here when both bounds are supplied together; a partial
  // update is re-checked against the stored record in the service layer.
  assertValidityOrder(validFrom, validUntil, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  if (
    proficiencyLevel === undefined &&
    validFrom === undefined &&
    validUntil === undefined &&
    status === undefined
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'body',
        message:
          'At least one of proficiencyLevel, validFrom, validUntil, or status must be provided.',
      },
    ]);
  }

  return {
    ...(proficiencyLevel === undefined ? {} : { proficiencyLevel }),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(status === undefined ? {} : { status }),
  };
}

function assertValidityOrder(
  validFrom: Date | null | undefined,
  validUntil: Date | null | undefined,
  details: ValidationDetail[],
): void {
  if (
    validFrom instanceof Date &&
    validUntil instanceof Date &&
    validUntil < validFrom
  ) {
    details.push({
      field: 'validUntil',
      message: 'validUntil must be the same as or after validFrom.',
    });
  }
}

function readSkillId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'skillId',
      message: 'skillId is required and must be a valid UUID.',
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readProficiencyLevel(
  value: unknown,
  details: ValidationDetail[],
): ProficiencyLevel | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isProficiencyLevel(value)) {
    details.push({
      field: 'proficiencyLevel',
      message: `Proficiency level must be one of: ${PROFICIENCY_LEVELS.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): WorkforceSkillStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isWorkforceSkillStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${WORKFORCE_SKILL_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

/**
 * Optional validity bound. An explicit `null` is meaningful — it clears the
 * bound — so it is preserved rather than treated as "absent".
 */
function readOptionalDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    details.push({
      field,
      message: `${field} must be a valid ISO-8601 date string.`,
    });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    details.push({
      field,
      message: `${field} must be a valid ISO-8601 date string.`,
    });
    return undefined;
  }

  return date;
}
