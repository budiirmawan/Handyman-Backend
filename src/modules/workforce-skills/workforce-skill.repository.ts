import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { SkillCategory } from '../skills';
import type {
  EffectiveWorkforceSkill,
  NewWorkforceSkillAssignment,
  ProficiencyLevel,
  UpdateWorkforceSkillAssignmentInput,
  WorkforceSkillAssignmentRecord,
  WorkforceSkillStatus,
} from './workforce-skill.types';

type WorkforceSkillAssignmentRow = {
  id: string;
  workforce_profile_id: string;
  skill_id: string;
  proficiency_level: ProficiencyLevel;
  valid_from: Date | null;
  valid_until: Date | null;
  status: WorkforceSkillStatus;
  created_at: Date;
  updated_at: Date;
};

const ASSIGNMENT_SELECT = `
  id,
  workforce_profile_id,
  skill_id,
  proficiency_level,
  valid_from,
  valid_until,
  status,
  created_at,
  updated_at
`;

function mapRow(
  row: WorkforceSkillAssignmentRow,
): WorkforceSkillAssignmentRecord {
  return {
    id: row.id,
    workforceProfileId: row.workforce_profile_id,
    skillId: row.skill_id,
    proficiencyLevel: row.proficiency_level,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create(
  input: NewWorkforceSkillAssignment,
): Promise<WorkforceSkillAssignmentRecord> {
  const result = await getPool().query<WorkforceSkillAssignmentRow>(
    `INSERT INTO workforce_skill_assignments
       (id, workforce_profile_id, skill_id, proficiency_level,
        valid_from, valid_until, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${ASSIGNMENT_SELECT}`,
    [
      randomUUID(),
      input.workforceProfileId,
      input.skillId,
      input.proficiencyLevel,
      input.validFrom,
      input.validUntil,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(
  id: string,
): Promise<WorkforceSkillAssignmentRecord | null> {
  const result = await getPool().query<WorkforceSkillAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM workforce_skill_assignments WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** All assignments held by one Workforce Profile, active history included. */
async function listByWorkforceProfileId(
  workforceProfileId: string,
): Promise<WorkforceSkillAssignmentRecord[]> {
  const result = await getPool().query<WorkforceSkillAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM workforce_skill_assignments
     WHERE workforce_profile_id = $1
     ORDER BY created_at ASC`,
    [workforceProfileId],
  );

  return result.rows.map(mapRow);
}

/**
 * Resolves the assignment addressed by the API route
 * (`/workforce/:workforceId/skills/:skillId`). Prefers the ACTIVE row so an
 * update targets the live assignment rather than deactivated history.
 */
async function findByProfileAndSkill(
  workforceProfileId: string,
  skillId: string,
): Promise<WorkforceSkillAssignmentRecord | null> {
  const result = await getPool().query<WorkforceSkillAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM workforce_skill_assignments
     WHERE workforce_profile_id = $1 AND skill_id = $2
     ORDER BY (status = 'ACTIVE') DESC, created_at DESC
     LIMIT 1`,
    [workforceProfileId, skillId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findActiveByProfileAndSkill(
  workforceProfileId: string,
  skillId: string,
): Promise<WorkforceSkillAssignmentRecord | null> {
  const result = await getPool().query<WorkforceSkillAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM workforce_skill_assignments
     WHERE workforce_profile_id = $1 AND skill_id = $2 AND status = 'ACTIVE'`,
    [workforceProfileId, skillId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Partial update. Only the fields explicitly present in `input` are written, so
 * an absent key leaves the stored value untouched while an explicit `null`
 * clears a validity bound.
 */
async function update(
  id: string,
  input: UpdateWorkforceSkillAssignmentInput,
): Promise<WorkforceSkillAssignmentRecord | null> {
  const assignments: string[] = [];
  const values: unknown[] = [id];

  if (input.proficiencyLevel !== undefined) {
    values.push(input.proficiencyLevel);
    assignments.push(`proficiency_level = $${values.length}`);
  }
  if (input.validFrom !== undefined) {
    values.push(input.validFrom);
    assignments.push(`valid_from = $${values.length}`);
  }
  if (input.validUntil !== undefined) {
    values.push(input.validUntil);
    assignments.push(`valid_until = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    assignments.push(`status = $${values.length}`);
  }

  if (assignments.length === 0) {
    return findById(id);
  }

  const result = await getPool().query<WorkforceSkillAssignmentRow>(
    `UPDATE workforce_skill_assignments
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ASSIGNMENT_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

type EffectiveWorkforceSkillRow = {
  skill_id: string;
  code: string;
  name: string;
  category: SkillCategory;
  proficiency_level: ProficiencyLevel;
  valid_from: Date | null;
  valid_until: Date | null;
};

/**
 * BE-03D3 — resolves the Skills genuinely in force for a Workforce Profile.
 *
 * All four effectiveness rules are applied in SQL so the database is the single
 * arbiter and no partially-filtered set ever reaches the service layer:
 *   1. the assignment is ACTIVE,
 *   2. the joined Skill is ACTIVE,
 *   3. valid_from is absent or already reached,
 *   4. valid_until is absent or not yet passed.
 *
 * `asOf` is passed in rather than using NOW() so the caller controls the
 * reference instant and the behaviour is deterministic under test.
 */
async function listEffectiveSkills(
  workforceProfileId: string,
  asOf: Date,
): Promise<EffectiveWorkforceSkill[]> {
  const result = await getPool().query<EffectiveWorkforceSkillRow>(
    `SELECT
       s.id AS skill_id,
       s.code,
       s.name,
       s.category,
       wsa.proficiency_level,
       wsa.valid_from,
       wsa.valid_until
     FROM workforce_skill_assignments wsa
     JOIN skills s ON s.id = wsa.skill_id
     WHERE wsa.workforce_profile_id = $1
       AND wsa.status = 'ACTIVE'
       AND s.status = 'ACTIVE'
       AND (wsa.valid_from IS NULL OR wsa.valid_from <= $2)
       AND (wsa.valid_until IS NULL OR wsa.valid_until >= $2)
     ORDER BY s.code ASC`,
    [workforceProfileId, asOf],
  );

  return result.rows.map((row) => ({
    skillId: row.skill_id,
    code: row.code,
    name: row.name,
    category: row.category,
    proficiencyLevel: row.proficiency_level,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
  }));
}

export const workforceSkillRepository = {
  create,
  findActiveByProfileAndSkill,
  findById,
  findByProfileAndSkill,
  listByWorkforceProfileId,
  listEffectiveSkills,
  update,
};
