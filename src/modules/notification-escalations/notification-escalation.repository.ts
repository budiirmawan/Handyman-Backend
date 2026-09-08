import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { clampDueItemLimit } from '../../shared/due-retrieval';
import type {
  NotificationEscalationRecord,
  NotificationEscalationStatus,
  UpdateNotificationEscalationInput,
} from './notification-escalation.types';

/**
 * BE-26I — Notification escalation repository.
 *
 * Escalations are append-only records; the only mutations are the lifecycle
 * transitions PENDING → TRIGGERED (trigger) and PENDING → CANCELLED (cancel),
 * both guarded by `WHERE status = 'PENDING'` for idempotency/race safety.
 */

const SELECT_COLUMNS = `id,
  key,
  client_id AS "clientId",
  source_entity_type AS "sourceEntityType",
  source_entity_id AS "sourceEntityId",
  current_recipient_user_id AS "currentRecipientUserId",
  escalation_rule AS "escalationRule",
  template_key AS "templateKey",
  escalation_at AS "escalationAt",
  triggered_at AS "triggeredAt",
  status,
  reason,
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

export type NewNotificationEscalation = {
  key: string;
  clientId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  currentRecipientUserId: string | null;
  escalationRule: NotificationEscalationRecord['escalationRule'];
  templateKey: string;
  escalationAt: Date;
  reason: string | null;
};

async function create(
  input: NewNotificationEscalation,
): Promise<NotificationEscalationRecord> {
  const result = await getPool().query<NotificationEscalationRecord>(
    `INSERT INTO notification_escalations (
       id, key, client_id, source_entity_type, source_entity_id,
       current_recipient_user_id, escalation_rule, template_key,
       escalation_at, status, reason
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'PENDING', $10)
     RETURNING ${SELECT_COLUMNS}`,
    [
      randomUUID(),
      input.key,
      input.clientId,
      input.sourceEntityType,
      input.sourceEntityId,
      input.currentRecipientUserId,
      JSON.stringify(input.escalationRule),
      input.templateKey,
      input.escalationAt,
      input.reason,
    ],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<NotificationEscalationRecord | null> {
  const result = await getPool().query<NotificationEscalationRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_escalations
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByKey(key: string): Promise<NotificationEscalationRecord | null> {
  const result = await getPool().query<NotificationEscalationRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_escalations
      WHERE key = $1`,
    [key],
  );
  return result.rows[0] ?? null;
}

async function list(
  status?: NotificationEscalationStatus,
): Promise<NotificationEscalationRecord[]> {
  const params: unknown[] = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE status = $1';
  }
  const result = await getPool().query<NotificationEscalationRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_escalations
       ${where}
       ORDER BY escalation_at ASC, key ASC, id ASC`,
    params,
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateNotificationEscalationInput,
): Promise<NotificationEscalationRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (input.escalationAt !== undefined) {
    params.push(new Date(input.escalationAt));
    sets.push(`escalation_at = $${params.length}`);
  }
  if (input.currentRecipientUserId !== undefined) {
    params.push(input.currentRecipientUserId);
    sets.push(`current_recipient_user_id = $${params.length}`);
  }
  if (input.escalationRule !== undefined) {
    params.push(JSON.stringify(input.escalationRule));
    sets.push(`escalation_rule = $${params.length}::jsonb`);
  }
  if (input.templateKey !== undefined) {
    params.push(input.templateKey);
    sets.push(`template_key = $${params.length}`);
  }
  if (input.reason !== undefined) {
    params.push(input.reason);
    sets.push(`reason = $${params.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  params.push(id);
  const result = await getPool().query<NotificationEscalationRecord>(
    `UPDATE notification_escalations
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length} AND status = 'PENDING'
      RETURNING ${SELECT_COLUMNS}`,
    params,
  );
  return result.rows[0] ?? null;
}

/**
 * The scheduler seam: PENDING escalations due at or before `before`, bounded
 * to a small batch (CR-BE-STAB-03 PART 05) so a single pass never loads an
 * unbounded backlog. Leftover items stay PENDING for the next pass.
 */
async function findDue(
  before: Date,
  limit?: number,
): Promise<NotificationEscalationRecord[]> {
  const result = await getPool().query<NotificationEscalationRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_escalations
      WHERE status = 'PENDING' AND escalation_at <= $1
      ORDER BY escalation_at ASC, id ASC
      LIMIT $2`,
    [before, clampDueItemLimit(limit)],
  );
  return result.rows;
}

/** Atomically transitions PENDING → TRIGGERED and stamps triggered_at. */
async function markTriggered(
  id: string,
  triggeredAt: Date,
): Promise<NotificationEscalationRecord | null> {
  const result = await getPool().query<NotificationEscalationRecord>(
    `UPDATE notification_escalations
        SET status = 'TRIGGERED', triggered_at = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING ${SELECT_COLUMNS}`,
    [id, triggeredAt],
  );
  return result.rows[0] ?? null;
}

/** Atomically transitions PENDING → CANCELLED. */
async function markCancelled(id: string): Promise<NotificationEscalationRecord | null> {
  const result = await getPool().query<NotificationEscalationRecord>(
    `UPDATE notification_escalations
        SET status = 'CANCELLED', updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export const notificationEscalationRepository = {
  create,
  findById,
  findByKey,
  findDue,
  list,
  markCancelled,
  markTriggered,
  update,
};
