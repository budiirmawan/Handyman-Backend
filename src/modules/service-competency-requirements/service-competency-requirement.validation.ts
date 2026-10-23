import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isProficiencyLevel, PROFICIENCY_LEVELS } from '../workforce-skills';
import {
  isCompetencyEnforcementLevel,
  isCompetencyRequirementType,
  isCompetencyRequirementStatus,
  type CompetencyRequirementChanges,
  type CreateCompetencyRequirementInput,
  type ListCompetencyRequirementsFilter,
  type NewCompetencyRequirement,
  type UpdateCompetencyRequirementInput,
} from './service-competency-requirement.types';

export type ValidationDetail = { field: string; message: string };

const MAX_CERTIFICATE_NAME_LENGTH = 255;
const MAX_NOTES_LENGTH = 1000;

/**
 * Keys a client may supply. Anything else is rejected rather than ignored, so a
 * smuggled `clientId`, `status`, `serviceCatalogId` or `createdByUserId` can
 * never be silently accepted (PART 02 precedent).
 */
const CREATE_KEYS = new Set([
  'requirementType',
  'enforcementLevel',
  'skillId',
  'minimumProficiencyLevel',
  'certificateName',
  'notes',
]);

const UPDATE_KEYS = new Set([
  'enforcementLevel',
  'minimumProficiencyLevel',
  'certificateName',
  'notes',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function rejectUnknownKeys(
  body: Record<string, unknown>,
  allowed: Set<string>,
  details: ValidationDetail[],
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      details.push({
        field: key,
        message: `${key} is not an accepted field for this operation.`,
      });
    }
  }
}

function readOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined | null {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return trimmed.replace(/\s+/g, ' ');
}

export function parseServiceCatalogIdParam(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) fail([{ field: 'serviceCatalogId', message: 'serviceCatalogId must be a UUID.' }]);
  return raw;
}

export function parseRequirementIdParam(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) fail([{ field: 'requirementId', message: 'requirementId must be a UUID.' }]);
  return raw;
}

/**
 * Create validation.
 *
 * The shape rules mirror the database CHECK exactly, so a caller gets a 400
 * validation error with a field path instead of a 500 from PostgreSQL:
 *
 *   SKILL         → skillId + minimumProficiencyLevel required; certificateName
 *                   must be absent.
 *   CERTIFICATION → certificateName required; minimumProficiencyLevel must be
 *                   absent; skillId is optional narrowing.
 */
export function validateCreateCompetencyRequirementInput(
  serviceCatalogId: string,
  clientId: string,
  body: CreateCompetencyRequirementInput,
  actorUserId: string,
): NewCompetencyRequirement {
  const details: ValidationDetail[] = [];
  const raw: Record<string, unknown> = isRecord(body) ? body : {};
  rejectUnknownKeys(raw, CREATE_KEYS, details);

  const requirementType = raw.requirementType;
  if (!isCompetencyRequirementType(requirementType)) {
    details.push({
      field: 'requirementType',
      message: 'requirementType must be one of SKILL, CERTIFICATION.',
    });
  }

  let enforcementLevel: 'MANDATORY' | 'RECOMMENDED' = 'MANDATORY';
  if (raw.enforcementLevel !== undefined) {
    if (!isCompetencyEnforcementLevel(raw.enforcementLevel)) {
      details.push({
        field: 'enforcementLevel',
        message: 'enforcementLevel must be one of MANDATORY, RECOMMENDED.',
      });
    } else {
      enforcementLevel = raw.enforcementLevel;
    }
  }

  let skillId: string | null = null;
  if (raw.skillId !== undefined && raw.skillId !== null) {
    if (typeof raw.skillId !== 'string' || !isValidUuid(raw.skillId.trim())) {
      details.push({ field: 'skillId', message: 'skillId must be a UUID.' });
    } else {
      skillId = raw.skillId.trim();
    }
  }

  const minimumProficiencyLevel = raw.minimumProficiencyLevel ?? null;
  if (
    minimumProficiencyLevel !== null &&
    !isProficiencyLevel(minimumProficiencyLevel)
  ) {
    details.push({
      field: 'minimumProficiencyLevel',
      message: `minimumProficiencyLevel must be one of ${PROFICIENCY_LEVELS.join(', ')}.`,
    });
  }

  const certificateName = readOptionalText(
    raw.certificateName,
    'certificateName',
    MAX_CERTIFICATE_NAME_LENGTH,
    details,
  );

  const notes = readOptionalText(raw.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (isCompetencyRequirementType(requirementType)) {
    if (requirementType === 'SKILL') {
      if (skillId === null) {
        details.push({
          field: 'skillId',
          message: 'skillId is required for a SKILL requirement.',
        });
      }
      if (minimumProficiencyLevel === null) {
        details.push({
          field: 'minimumProficiencyLevel',
          message:
            'minimumProficiencyLevel is required for a SKILL requirement.',
        });
      }
      if (certificateName !== undefined && certificateName !== null) {
        details.push({
          field: 'certificateName',
          message: 'certificateName is not applicable to a SKILL requirement.',
        });
      }
    }
    if (requirementType === 'CERTIFICATION') {
      if (certificateName === undefined || certificateName === null) {
        details.push({
          field: 'certificateName',
          message: 'certificateName is required for a CERTIFICATION requirement.',
        });
      }
      if (minimumProficiencyLevel !== null) {
        details.push({
          field: 'minimumProficiencyLevel',
          message:
            'minimumProficiencyLevel is not applicable to a CERTIFICATION requirement.',
        });
      }
    }
  }

  if (details.length > 0) fail(details);

  return {
    clientId,
    serviceCatalogId,
    requirementType: requirementType as NewCompetencyRequirement['requirementType'],
    enforcementLevel,
    skillId,
    minimumProficiencyLevel:
      minimumProficiencyLevel as NewCompetencyRequirement['minimumProficiencyLevel'],
    certificateName: certificateName ?? null,
    notes: notes ?? null,
    createdByUserId: actorUserId,
  };
}

/**
 * PATCH validation. Type-specific rules depend on the EXISTING requirement
 * type, so the caller passes it in: a minimum proficiency can only be corrected
 * on a SKILL requirement and a certificate name only on a CERTIFICATION one.
 */
export function validateUpdateCompetencyRequirementInput(
  requirementType: 'SKILL' | 'CERTIFICATION',
  body: UpdateCompetencyRequirementInput,
): CompetencyRequirementChanges {
  const details: ValidationDetail[] = [];
  const raw: Record<string, unknown> = isRecord(body) ? body : {};
  rejectUnknownKeys(raw, UPDATE_KEYS, details);

  const changes: CompetencyRequirementChanges = {};

  if (raw.enforcementLevel !== undefined) {
    if (!isCompetencyEnforcementLevel(raw.enforcementLevel)) {
      details.push({
        field: 'enforcementLevel',
        message: 'enforcementLevel must be one of MANDATORY, RECOMMENDED.',
      });
    } else {
      changes.enforcementLevel = raw.enforcementLevel;
    }
  }

  if (raw.minimumProficiencyLevel !== undefined) {
    if (requirementType !== 'SKILL') {
      details.push({
        field: 'minimumProficiencyLevel',
        message:
          'minimumProficiencyLevel is not applicable to a CERTIFICATION requirement.',
      });
    } else if (!isProficiencyLevel(raw.minimumProficiencyLevel)) {
      details.push({
        field: 'minimumProficiencyLevel',
        message: `minimumProficiencyLevel must be one of ${PROFICIENCY_LEVELS.join(', ')}.`,
      });
    } else {
      changes.minimumProficiencyLevel = raw.minimumProficiencyLevel;
    }
  }

  if (raw.certificateName !== undefined) {
    if (requirementType !== 'CERTIFICATION') {
      details.push({
        field: 'certificateName',
        message: 'certificateName is not applicable to a SKILL requirement.',
      });
    } else if (typeof raw.certificateName !== 'string') {
      details.push({
        field: 'certificateName',
        message: 'certificateName must be a string.',
      });
    } else {
      const trimmed = raw.certificateName.trim().replace(/\s+/g, ' ');
      if (trimmed === '' || trimmed.length > MAX_CERTIFICATE_NAME_LENGTH) {
        details.push({
          field: 'certificateName',
          message: `certificateName must be between 1 and ${MAX_CERTIFICATE_NAME_LENGTH} characters.`,
        });
      } else {
        changes.certificateName = trimmed;
      }
    }
  }

  if (raw.notes !== undefined) {
    if (raw.notes === null) {
      changes.notes = null;
    } else if (typeof raw.notes !== 'string') {
      details.push({ field: 'notes', message: 'notes must be a string.' });
    } else {
      const trimmed = raw.notes.trim();
      if (trimmed.length > MAX_NOTES_LENGTH) {
        details.push({
          field: 'notes',
          message: `notes must be at most ${MAX_NOTES_LENGTH} characters.`,
        });
      } else {
        changes.notes = trimmed === '' ? null : trimmed;
      }
    }
  }

  if (details.length > 0) fail(details);
  return changes;
}

export function validateListCompetencyRequirementsFilter(
  query: Record<string, unknown>,
): ListCompetencyRequirementsFilter {
  const details: ValidationDetail[] = [];
  const first = (value: unknown): unknown =>
    Array.isArray(value) ? value[0] : value;

  const status = first(query.status);
  const enforcementLevel = first(query.enforcementLevel);
  const requirementType = first(query.requirementType);

  const filter: ListCompetencyRequirementsFilter = {};

  if (status !== undefined && status !== '') {
    if (!isCompetencyRequirementStatus(status)) {
      details.push({
        field: 'status',
        message: 'status must be one of ACTIVE, INACTIVE.',
      });
    } else {
      filter.status = status;
    }
  }

  if (enforcementLevel !== undefined && enforcementLevel !== '') {
    if (!isCompetencyEnforcementLevel(enforcementLevel)) {
      details.push({
        field: 'enforcementLevel',
        message: 'enforcementLevel must be one of MANDATORY, RECOMMENDED.',
      });
    } else {
      filter.enforcementLevel = enforcementLevel;
    }
  }

  if (requirementType !== undefined && requirementType !== '') {
    if (!isCompetencyRequirementType(requirementType)) {
      details.push({
        field: 'requirementType',
        message: 'requirementType must be one of SKILL, CERTIFICATION.',
      });
    } else {
      filter.requirementType = requirementType;
    }
  }

  if (details.length > 0) fail(details);
  return filter;
}
