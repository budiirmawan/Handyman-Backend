/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — competency requirements per JOB TYPE.
 *
 * A requirement belongs to ONE Service Catalog entry (0321) and states, for
 * that job type, either:
 *
 *   SKILL         — a skill the crew must hold, with a minimum proficiency
 *                   level drawn from the BE-03D2 vocabulary
 *                   (`BASIC < INTERMEDIATE < ADVANCED < EXPERT`).
 *   CERTIFICATION — a certificate name the crew must hold, matched
 *                   case-insensitively against
 *                   `workforce_certifications.certificate_name` (0461), with an
 *                   optional skill narrowing.
 *
 * Every requirement also carries an enforcement level:
 *
 *   MANDATORY   — a blocking gap; assignment/reassignment is refused.
 *   RECOMMENDED — advisory only; it is reported, never enforced.
 *
 * This module owns the CONFIGURATION of requirements. It does not evaluate
 * workers and it does not assign anybody: evaluation lives in
 * `worker-competency-eligibility` and enforcement stays in the one existing
 * assignment authority (CR-HM-04 `handyman-scope-assignment.service.ts`).
 *
 * Certifications are never mandatory for all workers: a Client with no
 * requirement rows has exactly the pre-PART-03A behaviour.
 */
import type { ProficiencyLevel } from '../workforce-skills';

export const COMPETENCY_REQUIREMENT_TYPES = [
  'SKILL',
  'CERTIFICATION',
] as const;

export type CompetencyRequirementType =
  (typeof COMPETENCY_REQUIREMENT_TYPES)[number];

export function isCompetencyRequirementType(
  value: unknown,
): value is CompetencyRequirementType {
  return (
    typeof value === 'string' &&
    (COMPETENCY_REQUIREMENT_TYPES as readonly string[]).includes(value)
  );
}

export const COMPETENCY_ENFORCEMENT_LEVELS = [
  'MANDATORY',
  'RECOMMENDED',
] as const;

export type CompetencyEnforcementLevel =
  (typeof COMPETENCY_ENFORCEMENT_LEVELS)[number];

export function isCompetencyEnforcementLevel(
  value: unknown,
): value is CompetencyEnforcementLevel {
  return (
    typeof value === 'string' &&
    (COMPETENCY_ENFORCEMENT_LEVELS as readonly string[]).includes(value)
  );
}

export const COMPETENCY_REQUIREMENT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type CompetencyRequirementStatus =
  (typeof COMPETENCY_REQUIREMENT_STATUSES)[number];

export function isCompetencyRequirementStatus(
  value: unknown,
): value is CompetencyRequirementStatus {
  return (
    typeof value === 'string' &&
    (COMPETENCY_REQUIREMENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Ordered proficiency scale. A worker at level N satisfies a requirement whose
 * minimum is <= N. Kept here (not inferred from the strings) so the comparison
 * is explicit and testable.
 */
export const PROFICIENCY_RANK: Readonly<Record<ProficiencyLevel, number>> = {
  BASIC: 1,
  INTERMEDIATE: 2,
  ADVANCED: 3,
  EXPERT: 4,
};

export function proficiencyRank(level: ProficiencyLevel): number {
  return PROFICIENCY_RANK[level];
}

export function meetsMinimumProficiency(
  actual: ProficiencyLevel,
  minimum: ProficiencyLevel,
): boolean {
  return proficiencyRank(actual) >= proficiencyRank(minimum);
}

/** Mirrors the database uniqueness comparison: trimmed, case-insensitive. */
export function normalizeCertificateName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export type CompetencyRequirementSkillSummary = {
  id: string;
  code: string;
  name: string;
  category: string;
  status: string;
};

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A — a requirement is configured against
 * exactly ONE target. The model is shared (one table, one service, one
 * evaluator): the target only decides where the requirement applies.
 */
export type CompetencyRequirementTarget =
  | { kind: 'SERVICE_CATALOG'; serviceCatalogId: string }
  | { kind: 'TRADE_CATEGORY'; tradeCategoryId: string };

/** Full database row as read by the repository. */
export type CompetencyRequirementRecord = {
  id: string;
  clientId: string;
  /** Set for a Service Catalog (job type) requirement, else null. */
  serviceCatalogId: string | null;
  /** Set for a Work Order trade category requirement, else null. */
  tradeCategoryId: string | null;
  requirementType: CompetencyRequirementType;
  enforcementLevel: CompetencyEnforcementLevel;
  skillId: string | null;
  skill: CompetencyRequirementSkillSummary | null;
  minimumProficiencyLevel: ProficiencyLevel | null;
  certificateName: string | null;
  notes: string | null;
  status: CompetencyRequirementStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation (timestamps ISO-8601). */
export type PublicCompetencyRequirement = Omit<
  CompetencyRequirementRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

export type CreateCompetencyRequirementInput = {
  requirementType?: unknown;
  enforcementLevel?: unknown;
  skillId?: unknown;
  minimumProficiencyLevel?: unknown;
  certificateName?: unknown;
  notes?: unknown;
};

/** Fully-resolved create payload ready for persistence. */
export type NewCompetencyRequirement = {
  clientId: string;
  serviceCatalogId: string | null;
  tradeCategoryId: string | null;
  requirementType: CompetencyRequirementType;
  enforcementLevel: CompetencyEnforcementLevel;
  skillId: string | null;
  minimumProficiencyLevel: ProficiencyLevel | null;
  certificateName: string | null;
  notes: string | null;
  createdByUserId: string;
};

/**
 * PATCH input. `requirementType`, `skillId` and `clientId` are immutable: a
 * requirement is a fact about a job type, and repointing it at another skill
 * would silently change what existing assignments were validated against.
 * Deactivate + create is the governed correction path.
 */
export type UpdateCompetencyRequirementInput = {
  enforcementLevel?: unknown;
  minimumProficiencyLevel?: unknown;
  certificateName?: unknown;
  notes?: unknown;
};

/** Fully-resolved update payload (only supplied fields). */
export type CompetencyRequirementChanges = {
  enforcementLevel?: CompetencyEnforcementLevel;
  minimumProficiencyLevel?: ProficiencyLevel;
  certificateName?: string;
  notes?: string | null;
};

export type ListCompetencyRequirementsFilter = {
  status?: CompetencyRequirementStatus;
  enforcementLevel?: CompetencyEnforcementLevel;
  requirementType?: CompetencyRequirementType;
};

/** Permission vocabulary reused by this surface (no new codes). */
export const COMPETENCY_REQUIREMENT_PERMISSIONS = {
  read: 'service_catalog.read',
  manage: 'service_catalog.manage',
} as const;

/**
 * PART 03B2A — the same configuration surface for the multi-trade Work Order
 * path reuses the Work Order vocabulary (`work_order.read` / `work_order.manage`),
 * so no new permission code is introduced and a broad permission never widens
 * reach.
 */
export const WORK_ORDER_TRADE_REQUIREMENT_PERMISSIONS = {
  read: 'work_order.read',
  manage: 'work_order.manage',
} as const;
