import { AppError } from '../../shared/errors';
import { organizationRepository } from '../organizations';
import { skillNotFoundError, skillRepository } from '../skills';
import {
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import {
  skillInactiveError,
  workforceSkillAlreadyAssignedError,
  workforceSkillAssignmentNotFoundError,
  workforceSkillClientMismatchError,
} from './workforce-skill.errors';
import { workforceSkillRepository } from './workforce-skill.repository';
import type {
  AssignWorkforceSkillInput,
  EffectiveWorkforceSkill,
  NewWorkforceSkillAssignment,
  PublicWorkforceSkillAssignment,
  UpdateWorkforceSkillAssignmentInput,
  WorkforceSkillAssignmentRecord,
} from './workforce-skill.types';

export function toPublicWorkforceSkillAssignment(
  record: WorkforceSkillAssignmentRecord,
): PublicWorkforceSkillAssignment {
  return {
    id: record.id,
    workforceProfileId: record.workforceProfileId,
    skillId: record.skillId,
    proficiencyLevel: record.proficiencyLevel,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
    status: record.status,
  };
}

/**
 * PostgreSQL unique-violation on the partial ACTIVE index — the race-condition
 * backstop behind the explicit duplicate pre-check.
 */
function isActiveAssignmentUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505' &&
    'constraint' in error &&
    (error as { constraint?: unknown }).constraint ===
      'workforce_skill_assignments_active_unique'
  );
}

/**
 * A Workforce Profile carries no `client_id` of its own — it is Client-scoped
 * transitively through its Organization. This is the single place that walks
 * that chain, so isolation cannot drift between operations.
 */
async function resolveWorkforceClientId(
  workforceProfileId: string,
): Promise<string> {
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile) {
    throw workforceProfileNotFoundError();
  }

  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    // A profile always points at a real organization (enforced by FK), so this
    // is a data-integrity fault rather than a caller error.
    throw workforceProfileNotFoundError();
  }

  return organization.clientId;
}

/**
 * Resolves and cross-validates both sides of the link.
 *
 * Order is deliberate and is what the tests pin down:
 *   1. unknown Workforce  → 404
 *   2. unknown Skill      → 404
 *   3. cross-Client pair  → 400 (before any state check, so a foreign Skill's
 *                                status is never observable)
 *   4. INACTIVE Skill     → 400
 */
async function assertAssignable(
  workforceProfileId: string,
  skillId: string,
): Promise<void> {
  const workforceClientId = await resolveWorkforceClientId(workforceProfileId);

  const skill = await skillRepository.findById(skillId);
  if (!skill) {
    throw skillNotFoundError();
  }

  if (skill.clientId !== workforceClientId) {
    throw workforceSkillClientMismatchError();
  }

  if (skill.status !== 'ACTIVE') {
    throw skillInactiveError();
  }
}

function assertValidityOrder(
  validFrom: Date | null,
  validUntil: Date | null,
): void {
  if (validFrom !== null && validUntil !== null && validUntil < validFrom) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'validUntil',
        message: 'validUntil must be the same as or after validFrom.',
      },
    ]);
  }
}

/**
 * Assigns a Skill to a Workforce Profile.
 *
 * This records a competency and nothing else: no Position, Role, Permission,
 * Team, Shift, or Building Assignment is read or written anywhere in this path.
 */
export async function assignSkillToWorkforce(
  input: AssignWorkforceSkillInput,
): Promise<PublicWorkforceSkillAssignment> {
  await assertAssignable(input.workforceProfileId, input.skillId);

  const status = input.status ?? 'ACTIVE';
  const validFrom = input.validFrom ?? null;
  const validUntil = input.validUntil ?? null;

  assertValidityOrder(validFrom, validUntil);

  if (status === 'ACTIVE') {
    const existing = await workforceSkillRepository.findActiveByProfileAndSkill(
      input.workforceProfileId,
      input.skillId,
    );
    if (existing) {
      throw workforceSkillAlreadyAssignedError();
    }
  }

  const newAssignment: NewWorkforceSkillAssignment = {
    workforceProfileId: input.workforceProfileId,
    skillId: input.skillId,
    proficiencyLevel: input.proficiencyLevel ?? 'BASIC',
    validFrom,
    validUntil,
    status,
  };

  try {
    const record = await workforceSkillRepository.create(newAssignment);
    return toPublicWorkforceSkillAssignment(record);
  } catch (error) {
    if (isActiveAssignmentUniqueViolation(error)) {
      throw workforceSkillAlreadyAssignedError();
    }
    throw error;
  }
}

/** Lists every Skill assignment held by one Workforce Profile. */
export async function listWorkforceSkills(
  workforceProfileId: string,
): Promise<PublicWorkforceSkillAssignment[]> {
  // Resolving the Client also proves the profile exists — unknown ids 404
  // rather than returning a misleading empty list.
  await resolveWorkforceClientId(workforceProfileId);

  const records =
    await workforceSkillRepository.listByWorkforceProfileId(workforceProfileId);

  return records.map(toPublicWorkforceSkillAssignment);
}

/**
 * Updates the assignment addressed by (workforce, skill).
 *
 * Deactivation is expressed as `status: 'INACTIVE'` on this same endpoint; the
 * row is retained so the competency history stays auditable.
 */
export async function updateWorkforceSkillAssignment(
  workforceProfileId: string,
  skillId: string,
  input: UpdateWorkforceSkillAssignmentInput,
): Promise<PublicWorkforceSkillAssignment> {
  const workforceClientId = await resolveWorkforceClientId(workforceProfileId);

  const skill = await skillRepository.findById(skillId);
  if (!skill) {
    throw skillNotFoundError();
  }
  if (skill.clientId !== workforceClientId) {
    throw workforceSkillClientMismatchError();
  }

  const existing = await workforceSkillRepository.findByProfileAndSkill(
    workforceProfileId,
    skillId,
  );
  if (!existing) {
    throw workforceSkillAssignmentNotFoundError();
  }

  // Merge against the stored record so a partial update cannot produce an
  // invalid window (e.g. moving only validUntil behind the stored validFrom).
  const validFrom =
    input.validFrom === undefined ? existing.validFrom : input.validFrom;
  const validUntil =
    input.validUntil === undefined ? existing.validUntil : input.validUntil;

  assertValidityOrder(validFrom, validUntil);

  // Re-activating requires the Skill to still be assignable and must not
  // collide with another live assignment of the same Skill.
  if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
    if (skill.status !== 'ACTIVE') {
      throw skillInactiveError();
    }

    const active = await workforceSkillRepository.findActiveByProfileAndSkill(
      workforceProfileId,
      skillId,
    );
    if (active) {
      throw workforceSkillAlreadyAssignedError();
    }
  }

  try {
    const record = await workforceSkillRepository.update(existing.id, input);
    if (!record) {
      throw workforceSkillAssignmentNotFoundError();
    }
    return toPublicWorkforceSkillAssignment(record);
  } catch (error) {
    if (isActiveAssignmentUniqueViolation(error)) {
      throw workforceSkillAlreadyAssignedError();
    }
    throw error;
  }
}

/** Convenience wrapper: deactivation is an update to `status: 'INACTIVE'`. */
export async function deactivateWorkforceSkillAssignment(
  workforceProfileId: string,
  skillId: string,
): Promise<PublicWorkforceSkillAssignment> {
  return updateWorkforceSkillAssignment(workforceProfileId, skillId, {
    status: 'INACTIVE',
  });
}

/**
 * BE-03D3 — resolves the Skills a Workforce Profile actually holds right now.
 *
 * A Skill is effective only when every one of these is true:
 *   - the Workforce Skill Assignment is ACTIVE,
 *   - the Skill in the catalog is ACTIVE,
 *   - `validFrom` is empty or has already been reached,
 *   - `validUntil` is empty or has not yet passed.
 *
 * This is a pure read: it never writes, and it never touches Role, Permission,
 * Position, Team, Shift, or Building Assignment. It is the reusable entry point
 * later slices should call instead of re-deriving effectiveness themselves —
 * scheduling and workforce selection are explicitly out of scope here.
 *
 * `asOf` defaults to now and exists so callers (and tests) can evaluate the
 * same profile against a chosen instant deterministically.
 */
export async function resolveEffectiveSkillsForWorkforce(
  workforceProfileId: string,
  asOf: Date = new Date(),
): Promise<EffectiveWorkforceSkill[]> {
  // Resolving the Client proves the profile exists, so an unknown id is a
  // controlled 404 rather than a misleading empty result.
  await resolveWorkforceClientId(workforceProfileId);

  return workforceSkillRepository.listEffectiveSkills(workforceProfileId, asOf);
}

export const workforceSkillService = {
  assignSkillToWorkforce,
  deactivateWorkforceSkillAssignment,
  listWorkforceSkills,
  resolveEffectiveSkillsForWorkforce,
  toPublicWorkforceSkillAssignment,
  updateWorkforceSkillAssignment,
};
