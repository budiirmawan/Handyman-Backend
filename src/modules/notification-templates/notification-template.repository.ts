import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateNotificationTemplateInput,
  NotificationTemplateRecord,
  UpdateNotificationTemplateInput,
} from './notification-template.types';

/**
 * BE-26B — Notification template repository.
 *
 * Append-only by lifecycle: updates are allowed while a template is a
 * configuration recipe, but deactivation sets `status: 'INACTIVE'` — rows are
 * never hard-deleted through the foundation.
 */

const SELECT_COLUMNS = `id,
  key,
  type,
  channel,
  subject,
  body,
  variables,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

async function create(
  input: CreateNotificationTemplateInput,
): Promise<NotificationTemplateRecord> {
  const result = await getPool().query<NotificationTemplateRecord>(
    `INSERT INTO notification_templates (
       id, key, type, channel, subject, body, variables, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'ACTIVE')
     RETURNING ${SELECT_COLUMNS}`,
    [
      randomUUID(),
      input.key,
      input.type,
      input.channel,
      input.subject,
      input.body ?? null,
      JSON.stringify(input.variables ?? []),
    ],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<NotificationTemplateRecord | null> {
  const result = await getPool().query<NotificationTemplateRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_templates
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByKey(key: string): Promise<NotificationTemplateRecord | null> {
  const result = await getPool().query<NotificationTemplateRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_templates
      WHERE key = $1`,
    [key],
  );
  return result.rows[0] ?? null;
}

async function list(
  status?: NotificationTemplateRecord['status'],
): Promise<NotificationTemplateRecord[]> {
  const params: unknown[] = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE status = $1';
  }
  const result = await getPool().query<NotificationTemplateRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_templates
       ${where}
       ORDER BY key ASC, id ASC`,
    params,
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateNotificationTemplateInput,
): Promise<NotificationTemplateRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [field, column] of [
    ['type', 'type'],
    ['channel', 'channel'],
    ['subject', 'subject'],
    ['body', 'body'],
    ['status', 'status'],
  ] as const) {
    if (input[field] !== undefined) {
      params.push(input[field]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (input.variables !== undefined) {
    params.push(JSON.stringify(input.variables));
    sets.push(`variables = $${params.length}::jsonb`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  params.push(id);
  const result = await getPool().query<NotificationTemplateRecord>(
    `UPDATE notification_templates
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length}
      RETURNING ${SELECT_COLUMNS}`,
    params,
  );
  return result.rows[0] ?? null;
}

export const notificationTemplateRepository = {
  create,
  findById,
  findByKey,
  list,
  update,
};
