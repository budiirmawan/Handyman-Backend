import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  NewOperationalIncident,
  OperationalIncidentCompositeRecord,
  OperationalIncidentFilters,
  OperationalIncidentRecord,
  OperationalIncidentStatus,
  UpdateOperationalIncidentInput,
} from './operational-incident.types';

type Executor = Pick<PoolClient, 'query'>;

/**
 * Foundation columns are always READ from `incidents` — never duplicated into
 * `operational_incidents`. This JOIN is the composition, so BE-21A remains
 * the single source of truth for Incident identity, context, and lifecycle.
 */
const SELECT = `
  oi.id,
  oi.incident_id AS "incidentId",
  oi.operational_category AS "operationalCategory",
  oi.occurred_at AS "occurredAt",
  oi.operational_status AS "operationalStatus",
  oi.status_changed_at AS "statusChangedAt",
  oi.notes,
  oi.created_by_user_id AS "createdByUserId",
  oi.created_at AS "createdAt",
  oi.updated_at AS "updatedAt",
  oi.reported_shift_assignment_id AS "reportedShiftAssignmentId",
  oi.reported_security_post_id AS "reportedSecurityPostId",
  i.client_id AS "clientId",
  i.building_id AS "buildingId",
  i.incident_number AS "incidentNumber",
  i.incident_type AS "incidentType",
  i.title,
  i.description,
  i.severity,
  i.priority,
  i.status AS "incidentStatus",
  i.location_type AS "locationType",
  i.floor_id AS "floorId",
  i.area_id AS "areaId",
  i.room_id AS "roomId",
  i.space_id AS "spaceId",
  i.functional_location_id AS "functionalLocationId",
  i.reported_by_user_id AS "reportedByUserId",
  i.reported_at AS "reportedAt"
`;

const FROM = `
  FROM operational_incidents oi
  JOIN incidents i ON i.id = oi.incident_id
`;

async function create(
  input: NewOperationalIncident,
  executor: Executor = getPool(),
): Promise<OperationalIncidentRecord> {
  const result = await executor.query<OperationalIncidentRecord>(
    `INSERT INTO operational_incidents
       (id, incident_id, operational_category, occurred_at, notes,
        created_by_user_id, reported_shift_assignment_id, reported_security_post_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING
       id,
       incident_id AS "incidentId",
       operational_category AS "operationalCategory",
       occurred_at AS "occurredAt",
       operational_status AS "operationalStatus",
       status_changed_at AS "statusChangedAt",
       notes,
       created_by_user_id AS "createdByUserId",
       created_at AS "createdAt",
       updated_at AS "updatedAt",
       reported_shift_assignment_id AS "reportedShiftAssignmentId",
       reported_security_post_id AS "reportedSecurityPostId"`,
    [
      randomUUID(),
      input.incidentId,
      input.operationalCategory,
      input.occurredAt,
      input.notes,
      input.createdByUserId,
      input.reportedShiftAssignmentId ?? null,
      input.reportedSecurityPostId ?? null,
    ],
  );
  return result.rows[0];
}

/** Addressed by the SHARED BE-21A Incident id, not the specialization id. */
async function findByIncidentId(
  incidentId: string,
): Promise<OperationalIncidentCompositeRecord | null> {
  const result = await getPool().query<OperationalIncidentCompositeRecord>(
    `SELECT ${SELECT} ${FROM} WHERE oi.incident_id = $1`,
    [incidentId],
  );
  return result.rows[0] ?? null;
}

/**
 * Listing is ALWAYS constrained to the caller's accessible Buildings in SQL,
 * so an out-of-scope Operational Incident is never loaded into memory.
 */
async function list(
  filters: OperationalIncidentFilters,
  accessibleBuildingIds: string[],
): Promise<OperationalIncidentCompositeRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];

  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['i.building_id = ANY($1::uuid[])'];

  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`i.building_id = $${values.length}`);
  }
  if (filters.locationType) {
    values.push(filters.locationType);
    conditions.push(`i.location_type = $${values.length}`);
  }
  if (filters.locationId) {
    values.push(filters.locationId);
    conditions.push(`$${values.length} IN (
      i.floor_id, i.area_id, i.room_id, i.space_id, i.functional_location_id
    )`);
  }
  if (filters.operationalCategory) {
    values.push(filters.operationalCategory);
    conditions.push(`oi.operational_category = $${values.length}`);
  }
  if (filters.severity) {
    values.push(filters.severity);
    conditions.push(`i.severity = $${values.length}`);
  }
  if (filters.priority) {
    values.push(filters.priority);
    conditions.push(`i.priority = $${values.length}`);
  }
  if (filters.operationalStatus) {
    values.push(filters.operationalStatus);
    conditions.push(`oi.operational_status = $${values.length}`);
  }
  if (filters.incidentStatus) {
    values.push(filters.incidentStatus);
    conditions.push(`i.status = $${values.length}`);
  }
  if (filters.occurredFrom) {
    values.push(filters.occurredFrom);
    conditions.push(`oi.occurred_at >= $${values.length}`);
  }
  if (filters.occurredTo) {
    values.push(filters.occurredTo);
    conditions.push(`oi.occurred_at <= $${values.length}`);
  }

  const result = await getPool().query<OperationalIncidentCompositeRecord>(
    `SELECT ${SELECT} ${FROM}
     WHERE ${conditions.join(' AND ')}
     ORDER BY oi.occurred_at DESC, oi.id DESC`,
    values,
  );
  return result.rows;
}

/** Updates only the BE-21B operational columns. */
async function update(
  incidentId: string,
  input: Pick<
    UpdateOperationalIncidentInput,
    'operationalCategory' | 'occurredAt' | 'notes'
  >,
  executor: Executor = getPool(),
): Promise<void> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  if (input.operationalCategory !== undefined) {
    values.push(input.operationalCategory);
    assignments.push(`operational_category = $${values.length}`);
  }
  if (input.occurredAt !== undefined) {
    values.push(input.occurredAt);
    assignments.push(`occurred_at = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    assignments.push(`notes = $${values.length}`);
  }
  if (assignments.length === 0) return;

  values.push(incidentId);
  await executor.query(
    `UPDATE operational_incidents
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE incident_id = $${values.length}`,
    values,
  );
}

/**
 * Guarded transition: the WHERE clause pins the expected current status, so a
 * concurrent transition cannot be silently overwritten.
 */
async function transitionStatus(
  incidentId: string,
  from: OperationalIncidentStatus,
  to: OperationalIncidentStatus,
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE operational_incidents
     SET operational_status = $3,
         status_changed_at = NOW(),
         updated_at = NOW()
     WHERE incident_id = $1 AND operational_status = $2`,
    [incidentId, from, to],
  );
  return (result.rowCount ?? 0) > 0;
}

export const operationalIncidentRepository = {
  create,
  findByIncidentId,
  list,
  transitionStatus,
  update,
};
