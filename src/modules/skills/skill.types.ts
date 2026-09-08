/**
 * BE-03D1 — Skill Catalog domain types.
 *
 * A Skill is the Client-scoped competency master record. It describes a
 * capability the Client recognises; it never records who holds that capability.
 * Workforce skill assignment (profile ↔ skill, proficiency, evidence) is
 * BE-03D2 and is intentionally absent here.
 */

export const SKILL_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type SkillStatus = (typeof SKILL_STATUSES)[number];

export function isSkillStatus(value: unknown): value is SkillStatus {
  return (
    typeof value === 'string' &&
    (SKILL_STATUSES as readonly string[]).includes(value)
  );
}

export const SKILL_CATEGORIES = [
  'TECHNICAL',
  'OPERATIONAL',
  'SAFETY',
  'SPECIALIST',
] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export function isSkillCategory(value: unknown): value is SkillCategory {
  return (
    typeof value === 'string' &&
    (SKILL_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type SkillRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  category: SkillCategory;
  status: SkillStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicSkill = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  category: SkillCategory;
  status: SkillStatus;
};

export type CreateSkillInput = {
  clientId: string;
  code: string;
  name: string;
  description?: string;
  category?: SkillCategory;
  status?: SkillStatus;
};

/** Fully-resolved skill data ready for persistence. */
export type NewSkill = {
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  category: SkillCategory;
  status: SkillStatus;
};
