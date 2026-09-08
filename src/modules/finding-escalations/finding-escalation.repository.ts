import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  FindingEscalationCompositeRecord,
  FindingEscalationFilters,
  FindingEscalationRecord,
  NewFindingEscalation,
  UpdateFindingEscalationInput,
} from './finding-escalation.types';

type Executor = Pick<PoolClient, 'query'>;

/**
 * Foundation columns are always READ from `incidents`, and Finding columns
 * from `findings` — neither is duplicated into
 * `finding_escalation_incidents`. This JOIN is the composition, so BE-21A
 * remains the single source of truth for Incident identity/context/lifecycle
 * and BE-09 for Finding state and workflow.
 *
 * Because `findingStatus` is projected live rather than copied, an escalation
 * can never show a stale Finding state.
 */
const SELECT = `
  fe.id,
  fe.incident_id AS "incidentId",
  fe.finding_id AS "findingId",
  fe.escalation_reason AS "escalationReason",
  fe.escalated_at AS "escalatedAt",
  fe.notes,
  fe.created_by_user_id AS "createdByUserId",
  fe.created_at AS "createdAt",
  fe.updated_at AS "updatedAt",
  i.client_id AS "clientId",
  i.building_id AS "buildingId",
  i.incident_number AS "incidentNumber",
  i.incident_type AS "incidentType",
  i.title,
  i.description,
  i.severity,
  i.priority,
  i.status AS "incidentStatus",
  i.reported_by_user_id AS "reportedByUserId",
  i.reported_at AS "reportedAt",
  f.client_id AS "findingClientId",
  f.building_id AS "findingBuildingId",
  f.finding_number AS "findingNumber",
  f.title AS "findingTitle",
  f.status AS "findingStatus",
  f.state_changed_at AS "findingStateChangedAt"
`;

const FROM = `
  FROM finding_escalation_incidents fe
  JOIN incidents i ON i.id = fe.incident_id
  JOIN findings f ON f.id = fe.finding_id
`;

async function create(
  input: NewFindingEscalation,
  executor: Executor = getPool(),
): Promise<FindingEscalationRecord> {
  const result = await executor.query<FindingEscalationRecord>(
    `INSERT INTO finding_escalation_incidents
       (id, incident_id, finding_id, escalation_reason, notes,
        created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING
       id,
       incident_id AS "incidentId",
       finding_id AS "findingId",
       escalation_reason AS "escalationReason",
       escalated_at AS "escalatedAt",
       notes,
       created_by_user_id AS "createdByUserId",
       created_at AS "createdAt",
       updated_at AS "updatedAt"`,
    [
      randomUUID(),
      input.incidentId,
      input.findingId,
      input.escalationReason,
      input.notes,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

/**
 * Takes a row lock on the Finding for the remainder of the transaction.
 *
 * "At most one ACTIVE escalation per Finding" spans two tables, so it cannot
 * be a unique index. Without this lock, two concurrent escalations of the same
 * Finding would both pass the duplicate check and both insert. Locking the
 * FINDING row (rather than any escalation row) works even when no escalation
 * exists yet, which is precisely the racing case.
 *
 * Returns false when the Finding does not exist.
 */
async function lockFinding(
  findingId: string,
  executor: Executor,
): Promise<boolean> {
  const result = await executor.query(
    'SELECT id FROM findings WHERE id = $1 FOR UPDATE',
    [findingId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * The single ACTIVE escalation of a Finding, if any.
 *
 * "Active" means the escalation Incident still stands (`REPORTED`). A
 * CANCELLED escalation is spent, so the Finding may be escalated again — this
 * is what makes the constraint a business rule rather than a raw FK.
 */
async function findActiveByFindingId(
  findingId: string,
  executor: Executor = getPool(),
): Promise<FindingEscalationCompositeRecord | null> {
  const result = await executor.query<FindingEscalationCompositeRecord>(
    `SELECT ${SELECT} ${FROM}
     WHERE fe.finding_id = $1 AND i.status = 'REPORTED'`,
    [findingId],
  );
  return result.rows[0] ?? null;
}

/** Addressed by the SHARED BE-21A Incident id, not the specialization id. */
async function findByIncidentId(
  incidentId: string,
): Promise<FindingEscalationCompositeRecord | null> {
  const result = await getPool().query<FindingEscalationCompositeRecord>(
    `SELECT ${SELECT} ${FROM} WHERE fe.incident_id = $1`,
    [incidentId],
  );
  return result.rows[0] ?? null;
}

/**
 * Listing is ALWAYS constrained to the caller's accessible Buildings in SQL,
 * so an out-of-scope escalation is never loaded into memory.
 */
async function list(
  filters: FindingEscalationFilters,
  accessibleBuildingIds: string[],
): Promise<FindingEscalationCompositeRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];

  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['i.building_id = ANY($1::uuid[])'];

  if (filters.findingId) {
    values.push(filters.findingId);
    conditions.push(`fe.finding_id = $${values.length}`);
  }
  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`i.building_id = $${values.length}`);
  }
  if (filters.escalationReason) {
    values.push(filters.escalationReason);
    conditions.push(`fe.escalation_reason = $${values.length}`);
  }
  if (filters.severity) {
    values.push(filters.severity);
    conditions.push(`i.severity = $${values.length}`);
  }
  if (filters.priority) {
    values.push(filters.priority);
    conditions.push(`i.priority = $${values.length}`);
  }
  if (filters.incidentStatus) {
    values.push(filters.incidentStatus);
    conditions.push(`i.status = $${values.length}`);
  }
  // Filters on live BE-09 state — never on a local copy of it.
  if (filters.findingStatus) {
    values.push(filters.findingStatus);
    conditions.push(`f.status = $${values.length}`);
  }
  if (filters.escalatedFrom) {
    values.push(filters.escalatedFrom);
    conditions.push(`fe.escalated_at >= $${values.length}`);
  }
  if (filters.escalatedTo) {
    values.push(filters.escalatedTo);
    conditions.push(`fe.escalated_at <= $${values.length}`);
  }

  const result = await getPool().query<FindingEscalationCompositeRecord>(
    `SELECT ${SELECT} ${FROM}
     WHERE ${conditions.join(' AND ')}
     ORDER BY fe.escalated_at DESC, fe.id DESC`,
    values,
  );
  return result.rows;
}

/** Updates only the BE-21D escalation columns. */
async function update(
  incidentId: string,
  input: Pick<UpdateFindingEscalationInput, 'escalationReason' | 'notes'>,
  executor: Executor = getPool(),
): Promise<void> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  if (input.escalationReason !== undefined) {
    values.push(input.escalationReason);
    assignments.push(`escalation_reason = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    assignments.push(`notes = $${values.length}`);
  }
  if (assignments.length === 0) return;

  values.push(incidentId);
  await executor.query(
    `UPDATE finding_escalation_incidents
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE incident_id = $${values.length}`,
    values,
  );
}

export const findingEscalationRepository = {
  create,
  findActiveByFindingId,
  findByIncidentId,
  list,
  lockFinding,
  update,
};
