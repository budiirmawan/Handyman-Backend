import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  IncidentFilters,
  IncidentRecord,
  NewIncident,
  UpdateIncidentInput,
} from './incident.types';

/**
 * A specialization (BE-21B onward) creates its own row in the same
 * transaction as the foundation Incident, so writes accept an optional
 * transaction client. Passing none uses the pool, exactly as before.
 */
type Executor = Pick<PoolClient, 'query'>;

const SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  incident_number AS "incidentNumber",
  incident_type AS "incidentType",
  title,
  description,
  severity,
  priority,
  status,
  location_type AS "locationType",
  floor_id AS "floorId",
  area_id AS "areaId",
  room_id AS "roomId",
  space_id AS "spaceId",
  functional_location_id AS "functionalLocationId",
  reported_by_user_id AS "reportedByUserId",
  reported_at AS "reportedAt",
  cancelled_at AS "cancelledAt",
  cancelled_by_user_id AS "cancelledByUserId",
  closed_at AS "closedAt",
  closed_by_user_id AS "closedByUserId",
  closure_notes AS "closureNotes",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create(
  input: NewIncident,
  executor: Executor = getPool(),
): Promise<IncidentRecord> {
  const result = await executor.query<IncidentRecord>(
    `INSERT INTO incidents
       (id, client_id, building_id, incident_number, incident_type, title,
        description, severity, priority, location_type, floor_id, area_id,
        room_id, space_id, functional_location_id, reported_by_user_id,
        reported_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.incidentNumber,
      input.incidentType,
      input.title,
      input.description,
      input.severity,
      input.priority,
      input.locationType,
      input.floorId,
      input.areaId,
      input.roomId,
      input.spaceId,
      input.functionalLocationId,
      input.reportedByUserId,
      input.reportedAt,
    ],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<IncidentRecord | null> {
  const result = await getPool().query<IncidentRecord>(
    `SELECT ${SELECT} FROM incidents WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByClientAndNumber(
  clientId: string,
  incidentNumber: string,
): Promise<IncidentRecord | null> {
  const result = await getPool().query<IncidentRecord>(
    `SELECT ${SELECT} FROM incidents
     WHERE client_id = $1 AND incident_number = $2`,
    [clientId, incidentNumber],
  );
  return result.rows[0] ?? null;
}

/**
 * Listing is ALWAYS scoped to the Buildings the caller can access. The scope
 * is applied in SQL (`building_id = ANY(...)`) rather than filtered after a
 * global fetch, so an inaccessible Incident is never loaded into memory.
 */
async function list(
  filters: IncidentFilters,
  accessibleBuildingIds: string[],
): Promise<IncidentRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];

  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['building_id = ANY($1::uuid[])'];

  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`building_id = $${values.length}`);
  }
  if (filters.incidentType) {
    values.push(filters.incidentType);
    conditions.push(`incident_type = $${values.length}`);
  }
  if (filters.severity) {
    values.push(filters.severity);
    conditions.push(`severity = $${values.length}`);
  }
  if (filters.priority) {
    values.push(filters.priority);
    conditions.push(`priority = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<IncidentRecord>(
    `SELECT ${SELECT} FROM incidents
     WHERE ${conditions.join(' AND ')}
     ORDER BY reported_at DESC, id DESC`,
    values,
  );
  return result.rows;
}

/** Updates descriptive metadata only, and only while REPORTED. */
async function updateReported(
  id: string,
  input: UpdateIncidentInput,
  executor: Executor = getPool(),
): Promise<IncidentRecord | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  if (input.title !== undefined) {
    values.push(input.title);
    assignments.push(`title = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    assignments.push(`description = $${values.length}`);
  }
  if (input.severity !== undefined) {
    values.push(input.severity);
    assignments.push(`severity = $${values.length}`);
  }
  if (input.priority !== undefined) {
    values.push(input.priority);
    assignments.push(`priority = $${values.length}`);
  }
  if (assignments.length === 0) return findById(id);

  values.push(id);
  const result = await executor.query<IncidentRecord>(
    `UPDATE incidents
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length} AND status = 'REPORTED'
     RETURNING ${SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

async function cancelReported(
  id: string,
  cancelledByUserId: string,
): Promise<IncidentRecord | null> {
  const result = await getPool().query<IncidentRecord>(
    `UPDATE incidents
     SET status = 'CANCELLED',
         cancelled_at = NOW(),
         cancelled_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'REPORTED'
     RETURNING ${SELECT}`,
    [id, cancelledByUserId],
  );
  return result.rows[0] ?? null;
}

/**
 * BE-21K — seals the Incident.
 *
 * Guarded on `status = 'REPORTED'`, which is what makes closure idempotent-
 * safe rather than merely checked: a second concurrent close matches no row
 * and returns null, so a recorded closure can never be overwritten or
 * re-stamped with a later timestamp. The same guard means a CANCELLED
 * Incident can never be closed.
 *
 * Status and closure metadata are written in ONE statement so
 * `incidents_state_check` is never transiently violated.
 */
async function closeReported(
  id: string,
  input: { closedByUserId: string; closureNotes: string | null },
): Promise<IncidentRecord | null> {
  const result = await getPool().query<IncidentRecord>(
    `UPDATE incidents
     SET status = 'CLOSED',
         closed_at = NOW(),
         closed_by_user_id = $2,
         closure_notes = $3,
         updated_at = NOW()
     WHERE id = $1 AND status = 'REPORTED'
     RETURNING ${SELECT}`,
    [id, input.closedByUserId, input.closureNotes],
  );
  return result.rows[0] ?? null;
}

export const incidentRepository = {
  cancelReported,
  closeReported,
  create,
  findByClientAndNumber,
  findById,
  list,
  updateReported,
};
