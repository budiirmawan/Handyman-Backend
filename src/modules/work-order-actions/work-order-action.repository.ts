import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  WorkOrderActionRecord,
  WorkOrderActionType,
} from './work-order-action.types';

type WorkOrderActionRow = {
  id: string;
  workOrderId: string;
  actionType: WorkOrderActionType;
  actorUserId: string;
  notes: string | null;
  occurredAt: Date;
  createdAt: Date;
};

const ACTION_SELECT = `
  id,
  work_order_id AS "workOrderId",
  action_type AS "actionType",
  actor_user_id AS "actorUserId",
  notes,
  occurred_at AS "occurredAt",
  created_at AS "createdAt"
`;

function mapRow(row: WorkOrderActionRow): WorkOrderActionRecord {
  return {
    id: row.id,
    workOrderId: row.workOrderId,
    actionType: row.actionType,
    actorUserId: row.actorUserId,
    notes: row.notes,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

async function create(
  input: {
    workOrderId: string;
    actionType: WorkOrderActionType;
    actorUserId: string;
    notes: string | null;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<WorkOrderActionRecord> {
  const result = await executor.query<WorkOrderActionRow>(
    `INSERT INTO work_order_actions
       (id, work_order_id, action_type, actor_user_id, notes, occurred_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING ${ACTION_SELECT}`,
    [
      randomUUID(),
      input.workOrderId,
      input.actionType,
      input.actorUserId,
      input.notes,
    ],
  );

  return mapRow(result.rows[0]);
}

async function listByWorkOrderId(
  workOrderId: string,
): Promise<WorkOrderActionRecord[]> {
  const result = await getPool().query<WorkOrderActionRow>(
    `SELECT ${ACTION_SELECT} FROM work_order_actions
     WHERE work_order_id = $1
     ORDER BY occurred_at ASC, created_at ASC`,
    [workOrderId],
  );

  return result.rows.map(mapRow);
}

export const workOrderActionRepository = {
  create,
  listByWorkOrderId,
};
