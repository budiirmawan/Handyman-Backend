/**
 * BE-03D2 — Workforce Skill Assignment domain types.
 *
 * Connects an existing Workforce Profile (BE-03C) to an existing Skill
 * (BE-03D1). The assignment is a competency record only — it never implies a
 * Position, Role, Permission, Team, Shift, or Building Assignment.
 *
 * `validFrom` / `validUntil` are both optional: an assignment with no window is
 * simply undated. Interpreting those dates against "now" is BE-03D3 effective
 * skill resolution — see `EffectiveWorkforceSkill` at the bottom of this file.
 */

import type { SkillCategory } from '../skills';

export const WORKFORCE_SKILL_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type WorkforceSkillStatus = (typeof WORKFORCE_SKILL_STATUSES)[number];

export function isWorkforceSkillStatus(
  value: unknown,
): value is WorkforceSkillStatus {
  return (
    typeof value === 'string' &&
    (WORKFORCE_SKILL_STATUSES as readonly string[]).includes(value)
  );
}

export const PROFICIENCY_LEVELS = [
  'BASIC',
  'INTERMEDIATE',
  'ADVANCED',
  'EXPERT',
] as const;

export type ProficiencyLevel = (typeof PROFICIENCY_LEVELS)[number];

export function isProficiencyLevel(value: unknown): value is ProficiencyLevel {
  return (
    typeof value === 'string' &&
    (PROFICIENCY_LEVELS as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type WorkforceSkillAssignmentRecord = {
  id: string;
  workforceProfileId: string;
  skillId: string;
  proficiencyLevel: ProficiencyLevel;
  validFrom: Date | null;
  validUntil: Date | null;
  status: WorkforceSkillStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicWorkforceSkillAssignment = {
  id: string;
  workforceProfileId: string;
  skillId: string;
  proficiencyLevel: ProficiencyLevel;
  validFrom: Date | null;
  validUntil: Date | null;
  status: WorkforceSkillStatus;
};

/** Input supplied by the API consumer when assigning a Skill. */
export type AssignWorkforceSkillInput = {
  workforceProfileId: string;
  skillId: string;
  proficiencyLevel?: ProficiencyLevel;
  validFrom?: Date | null;
  validUntil?: Date | null;
  status?: WorkforceSkillStatus;
};

/** Fully-resolved data ready for persistence. */
export type NewWorkforceSkillAssignment = {
  workforceProfileId: string;
  skillId: string;
  proficiencyLevel: ProficiencyLevel;
  validFrom: Date | null;
  validUntil: Date | null;
  status: WorkforceSkillStatus;
};

/**
 * BE-03D3 — a Skill that is genuinely in force for a Workforce Profile right
 * now: the assignment is ACTIVE, the Skill itself is ACTIVE, and the current
 * moment falls inside the assignment's validity window.
 *
 * Flattens the Skill catalog entry and the assignment into one read model so
 * consumers never have to re-join the two sides themselves.
 */
export type EffectiveWorkforceSkill = {
  skillId: string;
  code: string;
  name: string;
  category: SkillCategory;
  proficiencyLevel: ProficiencyLevel;
  validFrom: Date | null;
  validUntil: Date | null;
};

/** Partial update input. Deactivation is `status: 'INACTIVE'`. */
export type UpdateWorkforceSkillAssignmentInput = {
  proficiencyLevel?: ProficiencyLevel;
  validFrom?: Date | null;
  validUntil?: Date | null;
  status?: WorkforceSkillStatus;
};
