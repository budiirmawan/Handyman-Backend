import type { PoolClient } from 'pg';
import type { QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  HandymanExecutionScopeAssignmentRecord,
  HandymanExecutionScopeAssignmentStatus,
  NewHandymanExecutionScopeAssignment,
} from './handyman-scope-assignment.types';

/**
 * CR-HM-04 activation PART B — assignment repository. The ONLY writer
 * of `handyman_execution_scope_assignments` (insert + the one
 * ACTIVE → SUPERSEDED projection allowed by the PART A trigger).
 * Read-only scope lookups stay HERE (CR-HM-06's certified module is
 * never touched): the Authorization table is consumed by id, never
 * mutated.
 */

type Row = QueryResultRow;

const ASSIGNMENT_SELECT = `
  SELECT id, client_id, execution_scope_id,
         handyman_provider_context_id, handyman_crew_id, status,
         assigned_by_user_id, assigned_at, supersedes_assignment_id,
         created_at, updated_at
    FROM handyman_execution_scope_assignments`;

function map(row: Row): HandymanExecutionScopeAssignmentRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    handymanProviderContextId: row.handyman_provider_context_id,
    handymanCrewId: row.handyman_crew_id,
    status: row.status as HandymanExecutionScopeAssignmentStatus,
    assignedByUserId: row.assigned_by_user_id,
    assignedAt: row.assigned_at,
    supersedesAssignmentId: row.supersedes_assignment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Locked read of the CR-HM-06 authority row (target boundary lock). */
async function lockScopeById(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<{
  id: string;
  clientId: string;
  status: string;
  buildingId: string;
} | null> {
  const result = await executor.query(
    `SELECT id, client_id, status, building_id FROM handyman_execution_scopes
      WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        clientId: row.client_id,
        status: row.status,
        buildingId: row.building_id,
      }
    : null;
}

/** Plain (unlocked) read of the CR-HM-06 authority row. */
async function findScopeById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<{
  id: string;
  clientId: string;
  status: string;
  buildingId: string;
} | null> {
  const result = await executor.query(
    `SELECT id, client_id, status, building_id FROM handyman_execution_scopes
      WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        clientId: row.client_id,
        status: row.status,
        buildingId: row.building_id,
      }
    : null;
}

async function insertAssignment(
  executor: Pick<PoolClient, 'query'>,
  record: NewHandymanExecutionScopeAssignment,
): Promise<HandymanExecutionScopeAssignmentRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_execution_scope_assignments (
       id, client_id, execution_scope_id,
       handyman_provider_context_id, handyman_crew_id, status,
       assigned_by_user_id, supersedes_assignment_id
     ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7)
     RETURNING id, client_id, execution_scope_id,
               handyman_provider_context_id, handyman_crew_id, status,
               assigned_by_user_id, assigned_at,
               supersedes_assignment_id, created_at, updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.executionScopeId,
      record.handymanProviderContextId,
      record.handymanCrewId,
      record.assignedByUserId,
      record.supersedesAssignmentId,
    ],
  );
  return map(result.rows[0]);
}

/** Current ACTIVE row for a scope (at most one exists by partial index). */
async function findActiveAssignmentByScope(
  executor: Pick<PoolClient, 'query'> = getPool(),
  executionScopeId: string,
): Promise<HandymanExecutionScopeAssignmentRecord | null> {
  const result = await executor.query(
    `${ASSIGNMENT_SELECT}
      WHERE execution_scope_id = $1 AND status = 'ACTIVE'`,
    [executionScopeId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** Boundary lock used by assign/reassign (serializes per-scope writes). */
async function lockActiveAssignmentByScope(
  executor: Pick<PoolClient, 'query'>,
  executionScopeId: string,
): Promise<HandymanExecutionScopeAssignmentRecord | null> {
  const result = await executor.query(
    `${ASSIGNMENT_SELECT}
      WHERE execution_scope_id = $1 AND status = 'ACTIVE'
      FOR UPDATE`,
    [executionScopeId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** The ONE permitted projection (guarded by the PART A trigger). */
async function supersedeAssignment(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanExecutionScopeAssignmentRecord | null> {
  const result = await executor.query(
    `UPDATE handyman_execution_scope_assignments
        SET status = 'SUPERSEDED', updated_at = NOW()
      WHERE id = $1
      RETURNING id, client_id, execution_scope_id,
                handyman_provider_context_id, handyman_crew_id, status,
                assigned_by_user_id, assigned_at,
                supersedes_assignment_id, created_at, updated_at`,
    [id],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

async function listActiveAssignmentsByCrew(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  crewId: string,
): Promise<HandymanExecutionScopeAssignmentRecord[]> {
  const result = await executor.query(
    `${ASSIGNMENT_SELECT}
      WHERE client_id = $1
        AND handyman_crew_id = $2
        AND status = 'ACTIVE'
      ORDER BY assigned_at ASC, id ASC`,
    [clientId, crewId],
  );
  return result.rows.map(map);
}

export const handymanScopeAssignmentRepository = {
  lockScopeById,
  findScopeById,
  insertAssignment,
  findActiveAssignmentByScope,
  lockActiveAssignmentByScope,
  supersedeAssignment,
  listActiveAssignmentsByCrew,
};
