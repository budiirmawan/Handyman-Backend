import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewWorkforceShiftAssignment,
  UpdateWorkforceShiftAssignmentInput,
  WorkforceShiftAssignmentRecord,
  WorkforceShiftStatus,
} from './workforce-shift.types';

type WorkforceShiftAssignmentRow = {
  id: string;
  workforce_profile_id: string;
  shift_id: string;
  security_post_id: string | null;
  effective_from: Date | null;
  effective_until: Date | null;
  status: WorkforceShiftStatus;
  created_at: Date;
  updated_at: Date;
};

const ASSIGNMENT_SELECT = `
  id,
  workforce_profile_id,
  shift_id,
  security_post_id,
  effective_from,
  effective_until,
  status,
  created_at,
  updated_at
`;

function mapRow(
  row: WorkforceShiftAssignmentRow,
): WorkforceShiftAssignmentRecord {
  return {
    id: row.id,
    workforceProfileId: row.workforce_profile_id,
    shiftId: row.shift_id,
    securityPostId: row.security_post_id,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create(
  input: NewWorkforceShiftAssignment,
): Promise<WorkforceShiftAssignmentRecord> {
  const result = await getPool().query<WorkforceShiftAssignmentRow>(
    `INSERT INTO workforce_shift_assignments
       (id, workforce_profile_id, shift_id, effective_from, effective_until, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ASSIGNMENT_SELECT}`,
    [
      randomUUID(),
      input.workforceProfileId,
      input.shiftId,
      input.effectiveFrom,
      input.effectiveUntil,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(
  id: string,
): Promise<WorkforceShiftAssignmentRecord | null> {
  const result = await getPool().query<WorkforceShiftAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM workforce_shift_assignments WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** All Shift assignments held by one Workforce Profile, history included. */
async function listByWorkforceProfileId(
  workforceProfileId: string,
): Promise<WorkforceShiftAssignmentRecord[]> {
  const result = await getPool().query<WorkforceShiftAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM workforce_shift_assignments
     WHERE workforce_profile_id = $1
     ORDER BY created_at ASC`,
    [workforceProfileId],
  );

  return result.rows.map(mapRow);
}

/**
 * Resolves the assignment addressed by the API route
 * (`/workforce/:workforceId/shifts/:shiftId`). Prefers the ACTIVE row so an
 * update targets the live assignment rather than deactivated history.
 */
async function findByProfileAndShift(
  workforceProfileId: string,
  shiftId: string,
): Promise<WorkforceShiftAssignmentRecord | null> {
  const result = await getPool().query<WorkforceShiftAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM workforce_shift_assignments
     WHERE workforce_profile_id = $1 AND shift_id = $2
     ORDER BY (status = 'ACTIVE') DESC, created_at DESC
     LIMIT 1`,
    [workforceProfileId, shiftId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findActiveByProfileAndShift(
  workforceProfileId: string,
  shiftId: string,
): Promise<WorkforceShiftAssignmentRecord | null> {
  const result = await getPool().query<WorkforceShiftAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM workforce_shift_assignments
     WHERE workforce_profile_id = $1 AND shift_id = $2 AND status = 'ACTIVE'`,
    [workforceProfileId, shiftId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Partial update. Only the fields explicitly present in `input` are written, so
 * an absent key leaves the stored value untouched while an explicit `null`
 * clears an effective bound.
 */
async function update(
  id: string,
  input: UpdateWorkforceShiftAssignmentInput,
): Promise<WorkforceShiftAssignmentRecord | null> {
  const assignments: string[] = [];
  const values: unknown[] = [id];

  if (input.effectiveFrom !== undefined) {
    values.push(input.effectiveFrom);
    assignments.push(`effective_from = $${values.length}`);
  }
  if (input.effectiveUntil !== undefined) {
    values.push(input.effectiveUntil);
    assignments.push(`effective_until = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    assignments.push(`status = $${values.length}`);
  }

  if (assignments.length === 0) {
    return findById(id);
  }

  const result = await getPool().query<WorkforceShiftAssignmentRow>(
    `UPDATE workforce_shift_assignments
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ASSIGNMENT_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Persists the Security Post binding (MOB-C03 PART 03A). `securityPostId`
 * is an explicit value: a non-null post id is set, and `null` clears the
 * binding. Same-Building validity is enforced by the service before this is
 * called; this method only writes the authoritative column.
 */
async function updateSecurityPost(
  id: string,
  securityPostId: string | null,
): Promise<WorkforceShiftAssignmentRecord | null> {
  const result = await getPool().query<WorkforceShiftAssignmentRow>(
    `UPDATE workforce_shift_assignments
     SET security_post_id = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ASSIGNMENT_SELECT}`,
    [id, securityPostId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const workforceShiftRepository = {
  create,
  findActiveByProfileAndShift,
  findById,
  findByProfileAndShift,
  listByWorkforceProfileId,
  update,
  updateSecurityPost,
};
