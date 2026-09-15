import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  SupervisorInspectionDecision,
  SupervisorInspectionFilter,
  SupervisorInspectionRecord,
  SupervisorInspectionStatus,
  SupervisorInspectionTargetType,
} from './supervisor-inspection.types';

type SupervisorInspectionRow = {
  id: string;
  client_id: string;
  building_id: string;
  cleaning_area_id: string;
  target_type: SupervisorInspectionTargetType;
  target_id: string;
  review_id: string | null;
  supervisor_user_id: string;
  decision: SupervisorInspectionDecision | null;
  status: SupervisorInspectionStatus;
  notes: string | null;
  inspected_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function mapRow(row: SupervisorInspectionRow): SupervisorInspectionRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    cleaningAreaId: row.cleaning_area_id,
    targetType: row.target_type,
    targetId: row.target_id,
    reviewId: row.review_id,
    supervisorUserId: row.supervisor_user_id,
    decision: row.decision,
    status: row.status,
    notes: row.notes,
    inspectedAt: row.inspected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(input: {
  clientId: string;
  buildingId: string;
  cleaningAreaId: string;
  targetType: SupervisorInspectionTargetType;
  targetId: string;
  reviewId: string | null;
  supervisorUserId: string;
  notes?: string | null;
}): Promise<SupervisorInspectionRecord> {
  const result = await getPool().query<SupervisorInspectionRow>(
    `INSERT INTO supervisor_inspections
       (id, client_id, building_id, cleaning_area_id, target_type,
        target_id, review_id, supervisor_user_id, notes, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING')
     RETURNING id, client_id, building_id, cleaning_area_id, target_type,
               target_id, review_id, supervisor_user_id, decision, status,
               notes, inspected_at, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.cleaningAreaId,
      input.targetType,
      input.targetId,
      input.reviewId,
      input.supervisorUserId,
      input.notes ?? null,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<SupervisorInspectionRecord | null> {
  const result = await getPool().query<SupervisorInspectionRow>(
    `SELECT id, client_id, building_id, cleaning_area_id, target_type,
            target_id, review_id, supervisor_user_id, decision, status,
            notes, inspected_at, created_at, updated_at
     FROM supervisor_inspections
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findPendingByTarget(
  targetType: SupervisorInspectionTargetType,
  targetId: string,
): Promise<SupervisorInspectionRecord | null> {
  const result = await getPool().query<SupervisorInspectionRow>(
    `SELECT id, client_id, building_id, cleaning_area_id, target_type,
            target_id, review_id, supervisor_user_id, decision, status,
            notes, inspected_at, created_at, updated_at
     FROM supervisor_inspections
     WHERE target_type = $1 AND target_id = $2 AND status = 'PENDING'`,
    [targetType, targetId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function list(
  filter: SupervisorInspectionFilter = {},
): Promise<SupervisorInspectionRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.buildingId) {
    values.push(filter.buildingId);
    conditions.push(`building_id = $${values.length}`);
  }

  if (filter.cleaningAreaId) {
    values.push(filter.cleaningAreaId);
    conditions.push(`cleaning_area_id = $${values.length}`);
  }

  if (filter.targetType) {
    values.push(filter.targetType);
    conditions.push(`target_type = $${values.length}`);
  }

  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await getPool().query<SupervisorInspectionRow>(
    `SELECT id, client_id, building_id, cleaning_area_id, target_type,
            target_id, review_id, supervisor_user_id, decision, status,
            notes, inspected_at, created_at, updated_at
     FROM supervisor_inspections
     ${whereClause}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function submitDecision(
  id: string,
  decision: SupervisorInspectionDecision,
  notes?: string | null,
): Promise<SupervisorInspectionRecord | null> {
  const result = await getPool().query<SupervisorInspectionRow>(
    `UPDATE supervisor_inspections
     SET decision = $1, notes = COALESCE($2, notes), status = 'COMPLETED',
         inspected_at = NOW(), updated_at = NOW()
     WHERE id = $3
     RETURNING id, client_id, building_id, cleaning_area_id, target_type,
               target_id, review_id, supervisor_user_id, decision, status,
               notes, inspected_at, created_at, updated_at`,
    [decision, notes ?? null, id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function createSharedReview(input: {
  clientId: string;
  targetType: string;
  targetId: string;
  reviewerUserId: string;
  notes?: string | null;
}): Promise<{ id: string }> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO reviews (id, client_id, target_type, target_id, reviewer_user_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      randomUUID(),
      input.clientId,
      input.targetType,
      input.targetId,
      input.reviewerUserId,
      input.notes ?? null,
    ],
  );
  return result.rows[0];
}

export async function updateSharedReview(
  reviewId: string,
  decision: SupervisorInspectionDecision,
  notes?: string | null,
): Promise<void> {
  await getPool().query(
    `UPDATE reviews
     SET decision = $1, notes = COALESCE($2, notes), status = 'COMPLETED',
         reviewed_at = NOW(), updated_at = NOW()
     WHERE id = $3`,
    [decision, notes ?? null, reviewId],
  );
}

export const supervisorInspectionRepository = {
  create,
  createSharedReview,
  findById,
  findPendingByTarget,
  list,
  submitDecision,
  updateSharedReview,
};
