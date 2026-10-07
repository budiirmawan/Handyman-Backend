import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  FindingFilters,
  FindingRecord,
  FindingStatus,
  NewFinding,
  UpdateFindingInput,
} from './finding.types';

type FindingRow = FindingRecord;

const FINDING_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  finding_number AS "findingNumber",
  title,
  description,
  classification_id AS "classificationId",
  severity_id AS "severityId",
  source_type AS "sourceType",
  source_id AS "sourceId",
  status,
  state_changed_at AS "stateChangedAt",
  reported_by_user_id AS "reportedByUserId",
  reported_at AS "reportedAt",
  closed_at AS "closedAt",
  closed_by_user_id AS "closedByUserId",
  closure_notes AS "closureNotes",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: FindingRow): FindingRecord {
  return { ...row };
}

async function create(
  input: NewFinding,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<FindingRecord> {
  const result = await executor.query<FindingRow>(
    `INSERT INTO findings
       (id, client_id, building_id, finding_number, title, description,
        reported_by_user_id, reported_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'OPEN')
     RETURNING ${FINDING_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.findingNumber,
      input.title,
      input.description,
      input.reportedByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<FindingRecord | null> {
  const result = await getPool().query<FindingRow>(
    `SELECT ${FINDING_SELECT} FROM findings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function findByNumberForClient(
  clientId: string,
  findingNumber: string,
): Promise<FindingRecord | null> {
  const result = await getPool().query<FindingRow>(
    `SELECT ${FINDING_SELECT} FROM findings
     WHERE client_id = $1 AND finding_number = $2`,
    [clientId, findingNumber],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function listByBuilding(
  buildingId: string,
  filters: FindingFilters,
): Promise<FindingRecord[]> {
  const values: unknown[] = [buildingId];
  const conditions = ['building_id = $1'];
  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  const result = await getPool().query<FindingRow>(
    `SELECT ${FINDING_SELECT} FROM findings
     WHERE ${conditions.join(' AND ')}
     ORDER BY reported_at DESC, created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

async function update(
  id: string,
  input: UpdateFindingInput,
): Promise<FindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.title !== undefined) {
    values.push(input.title);
    sets.push(`title = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.classificationId !== undefined) {
    values.push(input.classificationId);
    sets.push(`classification_id = $${values.length}`);
  }
  if (input.severityId !== undefined) {
    values.push(input.severityId);
    sets.push(`severity_id = $${values.length}`);
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<FindingRow>(
    `UPDATE findings SET ${sets.join(', ')}
     WHERE id = $${values.length}
     RETURNING ${FINDING_SELECT}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function updateSource(
  id: string,
  sourceType: import('./finding.types').FindingSourceType | null,
  sourceId: string | null,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<FindingRecord | null> {
  const result = await executor.query<FindingRow>(
    `UPDATE findings
     SET source_type = $2, source_id = $3, updated_at = NOW()
     WHERE id = $1 RETURNING ${FINDING_SELECT}`,
    [id, sourceType, sourceId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function updateStatus(
  id: string,
  status: FindingStatus,
): Promise<FindingRecord | null> {
  const result = await getPool().query<FindingRow>(
    `UPDATE findings
     SET status = $2, state_changed_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING ${FINDING_SELECT}`,
    [id, status],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function closeVerified(
  id: string,
  closedByUserId: string,
  closureNotes: string | null,
): Promise<FindingRecord | null> {
  const result = await getPool().query<FindingRow>(
    `UPDATE findings
     SET status = 'CLOSED', closed_at = NOW(), closed_by_user_id = $2,
         closure_notes = $3, state_changed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'VERIFIED' RETURNING ${FINDING_SELECT}`,
    [id, closedByUserId, closureNotes],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function transitionStatus(
  id: string,
  from: FindingStatus,
  to: FindingStatus,
): Promise<FindingRecord | null> {
  const result = await getPool().query<FindingRow>(
    `UPDATE findings
     SET status = $3, state_changed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = $2 RETURNING ${FINDING_SELECT}`,
    [id, from, to],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const findingRepository = {
  closeVerified,
  create,
  findById,
  findByNumberForClient,
  listByBuilding,
  transitionStatus,
  update,
  updateSource,
  updateStatus,
};
