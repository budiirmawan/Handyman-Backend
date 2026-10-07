import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import type {
  FindingAssignmentRecord,
  FindingAssignmentStatus,
  FindingAssigneeType,
  NewFindingAssignment,
} from './finding-assignment.types';

type Row = {
  id: string;
  findingId: string;
  assigneeType: FindingAssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  vendorId: string | null;
  assignedByUserId: string;
  assignedAt: Date;
  status: FindingAssignmentStatus;
  createdAt: Date;
  updatedAt: Date;
};
const SELECT = `id, finding_id AS "findingId", assignee_type AS "assigneeType",
  workforce_profile_id AS "workforceProfileId", team_id AS "teamId",
  vendor_id AS "vendorId", assigned_by_user_id AS "assignedByUserId",
  assigned_at AS "assignedAt", status, created_at AS "createdAt",
  updated_at AS "updatedAt"`;
const values = (input: NewFindingAssignment) => [
  randomUUID(), input.findingId, input.assigneeType, input.workforceProfileId,
  input.teamId, input.vendorId, input.assignedByUserId,
];

async function insert(client: PoolClient | null, input: NewFindingAssignment): Promise<Row> {
  const executor = client ?? getPool();
  const result = await executor.query<Row>(
    `INSERT INTO finding_assignments
       (id, finding_id, assignee_type, workforce_profile_id, team_id,
        vendor_id, assigned_by_user_id, assigned_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),'ACTIVE') RETURNING ${SELECT}`,
    values(input),
  );
  return result.rows[0];
}
async function create(input: NewFindingAssignment): Promise<FindingAssignmentRecord> {
  return insert(null, input);
}
async function findById(id: string): Promise<Row | null> {
  const result = await getPool().query<Row>(`SELECT ${SELECT} FROM finding_assignments WHERE id=$1`, [id]);
  return result.rows[0] ?? null;
}
async function findActiveByFindingId(findingId: string): Promise<Row | null> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM finding_assignments
     WHERE finding_id=$1 AND status='ACTIVE' LIMIT 1`,
    [findingId],
  );
  return result.rows[0] ?? null;
}
async function listByFindingId(findingId: string): Promise<Row[]> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM finding_assignments
     WHERE finding_id=$1 ORDER BY assigned_at, created_at`,
    [findingId],
  );
  return result.rows;
}
async function updateStatus(id: string, status: FindingAssignmentStatus): Promise<Row | null> {
  const result = await getPool().query<Row>(
    `UPDATE finding_assignments SET status=$2, updated_at=NOW()
     WHERE id=$1 RETURNING ${SELECT}`,
    [id, status],
  );
  return result.rows[0] ?? null;
}
async function replaceActive(input: NewFindingAssignment): Promise<Row> {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE finding_assignments SET status='INACTIVE', updated_at=NOW()
       WHERE finding_id=$1 AND status='ACTIVE'`,
      [input.findingId],
    );
    return insert(client, input);
  });
}

export const findingAssignmentRepository = {
  create,
  findActiveByFindingId,
  findById,
  listByFindingId,
  replaceActive,
  updateStatus,
};
