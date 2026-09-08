import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { clampDueItemLimit } from '../../shared/due-retrieval';
import type {
  NotificationReminderRecord,
  NotificationReminderStatus,
  UpdateNotificationReminderInput,
} from './notification-reminder.types';

/**
 * BE-26H — Notification reminder repository.
 *
 * Reminders are append-only records; the only mutations are the lifecycle
 * transitions PENDING → SENT (dispatch) and PENDING → CANCELLED (cancel),
 * both guarded by `WHERE status = 'PENDING'` for idempotency/race safety.
 */

const SELECT_COLUMNS = `id,
  key,
  client_id AS "clientId",
  source_entity_type AS "sourceEntityType",
  source_entity_id AS "sourceEntityId",
  recipient_rule AS "recipientRule",
  template_key AS "templateKey",
  variables,
  reminder_at AS "reminderAt",
  status,
  sent_at AS "sentAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

export type NewNotificationReminder = {
  key: string;
  clientId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  recipientRule: NotificationReminderRecord['recipientRule'];
  templateKey: string;
  variables: NotificationReminderRecord['variables'];
  reminderAt: Date;
};

async function create(
  input: NewNotificationReminder,
): Promise<NotificationReminderRecord> {
  const result = await getPool().query<NotificationReminderRecord>(
    `INSERT INTO notification_reminders (
       id, key, client_id, source_entity_type, source_entity_id,
       recipient_rule, template_key, variables, reminder_at, status
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, 'PENDING')
     RETURNING ${SELECT_COLUMNS}`,
    [
      randomUUID(),
      input.key,
      input.clientId,
      input.sourceEntityType,
      input.sourceEntityId,
      JSON.stringify(input.recipientRule),
      input.templateKey,
      JSON.stringify(input.variables),
      input.reminderAt,
    ],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<NotificationReminderRecord | null> {
  const result = await getPool().query<NotificationReminderRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_reminders
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByKey(key: string): Promise<NotificationReminderRecord | null> {
  const result = await getPool().query<NotificationReminderRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_reminders
      WHERE key = $1`,
    [key],
  );
  return result.rows[0] ?? null;
}

async function list(
  status?: NotificationReminderStatus,
): Promise<NotificationReminderRecord[]> {
  const params: unknown[] = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE status = $1';
  }
  const result = await getPool().query<NotificationReminderRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_reminders
       ${where}
       ORDER BY reminder_at ASC, key ASC, id ASC`,
    params,
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateNotificationReminderInput,
): Promise<NotificationReminderRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (input.reminderAt !== undefined) {
    params.push(new Date(input.reminderAt));
    sets.push(`reminder_at = $${params.length}`);
  }
  if (input.templateKey !== undefined) {
    params.push(input.templateKey);
    sets.push(`template_key = $${params.length}`);
  }
  if (input.recipientRule !== undefined) {
    params.push(JSON.stringify(input.recipientRule));
    sets.push(`recipient_rule = $${params.length}::jsonb`);
  }
  if (input.variables !== undefined) {
    params.push(JSON.stringify(input.variables));
    sets.push(`variables = $${params.length}::jsonb`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  params.push(id);
  const result = await getPool().query<NotificationReminderRecord>(
    `UPDATE notification_reminders
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length} AND status = 'PENDING'
      RETURNING ${SELECT_COLUMNS}`,
    params,
  );
  return result.rows[0] ?? null;
}

/**
 * The scheduler seam: PENDING reminders due at or before `before`, bounded to
 * a small batch (CR-BE-STAB-03 PART 05) so a single pass never loads an
 * unbounded backlog. Leftover items stay PENDING for the next pass.
 */
async function findDue(
  before: Date,
  limit?: number,
): Promise<NotificationReminderRecord[]> {
  const result = await getPool().query<NotificationReminderRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_reminders
      WHERE status = 'PENDING' AND reminder_at <= $1
      ORDER BY reminder_at ASC, id ASC
      LIMIT $2`,
    [before, clampDueItemLimit(limit)],
  );
  return result.rows;
}

/** Atomically transitions PENDING → SENT and stamps sent_at. */
async function markSent(
  id: string,
  sentAt: Date,
): Promise<NotificationReminderRecord | null> {
  const result = await getPool().query<NotificationReminderRecord>(
    `UPDATE notification_reminders
        SET status = 'SENT', sent_at = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING ${SELECT_COLUMNS}`,
    [id, sentAt],
  );
  return result.rows[0] ?? null;
}

/** Atomically transitions PENDING → CANCELLED. */
async function markCancelled(id: string): Promise<NotificationReminderRecord | null> {
  const result = await getPool().query<NotificationReminderRecord>(
    `UPDATE notification_reminders
        SET status = 'CANCELLED', updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export const notificationReminderRepository = {
  create,
  findById,
  findByKey,
  findDue,
  list,
  markCancelled,
  markSent,
  update,
};
