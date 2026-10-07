import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewWorkforceBuildingAssignment,
  UpdateWorkforceBuildingAssignmentInput,
  WorkforceBuildingAssignmentRecord,
  WorkforceBuildingAssignmentStatus,
  WorkforceBuildingContext,
} from './workforce-building-assignment.types';

type WorkforceBuildingAssignmentRow = {
  id: string;
  workforce_profile_id: string;
  building_id: string;
  effective_from: Date | null;
  effective_until: Date | null;
  status: WorkforceBuildingAssignmentStatus;
  created_at: Date;
  updated_at: Date;
};

type EffectiveBuildingRow = {
  id: string;
  workforce_profile_id: string;
  effective_from: Date | null;
  effective_until: Date | null;
  building_id: string;
  building_code: string;
  building_name: string;
  property_id: string;
};

const ASSIGNMENT_SELECT = `
  id,
  workforce_profile_id,
  building_id,
  effective_from,
  effective_until,
  status,
  created_at,
  updated_at
`;

function mapRow(
  row: WorkforceBuildingAssignmentRow,
): WorkforceBuildingAssignmentRecord {
  return {
    id: row.id,
    workforceProfileId: row.workforce_profile_id,
    buildingId: row.building_id,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEffectiveRow(row: EffectiveBuildingRow): WorkforceBuildingContext {
  return {
    assignmentId: row.id,
    workforceProfileId: row.workforce_profile_id,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    building: {
      id: row.building_id,
      code: row.building_code,
      name: row.building_name,
      propertyId: row.property_id,
    },
  };
}

async function create(
  input: NewWorkforceBuildingAssignment,
): Promise<WorkforceBuildingAssignmentRecord> {
  const result = await getPool().query<WorkforceBuildingAssignmentRow>(
    `INSERT INTO workforce_building_assignments
       (id, workforce_profile_id, building_id, effective_from, effective_until, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ASSIGNMENT_SELECT}`,
    [
      randomUUID(),
      input.workforceProfileId,
      input.buildingId,
      input.effectiveFrom,
      input.effectiveUntil,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(
  id: string,
): Promise<WorkforceBuildingAssignmentRecord | null> {
  const result = await getPool().query<WorkforceBuildingAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM workforce_building_assignments WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Every Building assignment held by one Workforce Profile, history included. */
async function listByWorkforceProfileId(
  workforceProfileId: string,
): Promise<WorkforceBuildingAssignmentRecord[]> {
  const result = await getPool().query<WorkforceBuildingAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM workforce_building_assignments
     WHERE workforce_profile_id = $1
     ORDER BY created_at ASC`,
    [workforceProfileId],
  );

  return result.rows.map(mapRow);
}

/** Every Workforce Profile assigned to one Building, history included. */
async function listByBuildingId(
  buildingId: string,
): Promise<WorkforceBuildingAssignmentRecord[]> {
  const result = await getPool().query<WorkforceBuildingAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM workforce_building_assignments
     WHERE building_id = $1
     ORDER BY created_at ASC`,
    [buildingId],
  );

  return result.rows.map(mapRow);
}

/**
 * Resolves the assignment addressed by the API route
 * (`/workforce/:workforceId/buildings/:buildingId`). Prefers the ACTIVE row so
 * an update targets the live assignment rather than deactivated history.
 */
async function findByProfileAndBuilding(
  workforceProfileId: string,
  buildingId: string,
): Promise<WorkforceBuildingAssignmentRecord | null> {
  const result = await getPool().query<WorkforceBuildingAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM workforce_building_assignments
     WHERE workforce_profile_id = $1 AND building_id = $2
     ORDER BY (status = 'ACTIVE') DESC, created_at DESC
     LIMIT 1`,
    [workforceProfileId, buildingId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findActiveByProfileAndBuilding(
  workforceProfileId: string,
  buildingId: string,
): Promise<WorkforceBuildingAssignmentRecord | null> {
  const result = await getPool().query<WorkforceBuildingAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM workforce_building_assignments
     WHERE workforce_profile_id = $1 AND building_id = $2 AND status = 'ACTIVE'`,
    [workforceProfileId, buildingId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * The effective placements of one Workforce Profile at a point in time.
 *
 * Effectiveness is decided in SQL so every caller gets the same answer: the
 * assignment must be ACTIVE, its window must cover `asOf` (open bounds count as
 * open-ended), and the Building itself must still be ACTIVE. Deactivating a
 * Building therefore removes it from everyone's effective set without touching
 * a single assignment row.
 */
async function listEffectiveByWorkforceProfileId(
  workforceProfileId: string,
  asOf: Date,
): Promise<WorkforceBuildingContext[]> {
  const result = await getPool().query<EffectiveBuildingRow>(
    `SELECT
       a.id,
       a.workforce_profile_id,
       a.effective_from,
       a.effective_until,
       b.id AS building_id,
       b.code AS building_code,
       b.name AS building_name,
       b.property_id
     FROM workforce_building_assignments a
     INNER JOIN buildings b ON b.id = a.building_id
     WHERE a.workforce_profile_id = $1
       AND a.status = 'ACTIVE'
       AND b.status = 'ACTIVE'
       AND (a.effective_from IS NULL OR a.effective_from <= $2)
       AND (a.effective_until IS NULL OR a.effective_until >= $2)
     ORDER BY b.code ASC`,
    [workforceProfileId, asOf],
  );

  return result.rows.map(mapEffectiveRow);
}

/**
 * Partial update. Only the fields explicitly present in `input` are written, so
 * an absent key leaves the stored value untouched while an explicit `null`
 * clears an effective bound.
 */
async function update(
  id: string,
  input: UpdateWorkforceBuildingAssignmentInput,
): Promise<WorkforceBuildingAssignmentRecord | null> {
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

  const result = await getPool().query<WorkforceBuildingAssignmentRow>(
    `UPDATE workforce_building_assignments
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ASSIGNMENT_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const workforceBuildingAssignmentRepository = {
  create,
  findActiveByProfileAndBuilding,
  findById,
  findByProfileAndBuilding,
  listByBuildingId,
  listByWorkforceProfileId,
  listEffectiveByWorkforceProfileId,
  update,
};
