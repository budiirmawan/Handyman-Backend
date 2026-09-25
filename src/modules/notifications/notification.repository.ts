import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewNotification,
  NotificationFilters,
  NotificationRecord,
} from './notification.types';

/**
 * BE-26A — Notification repository.
 *
 * All reads are recipient-scoped (ownership is enforced in SQL — a user can
 * only ever see their own notifications), and creation is append-only with an
 * UNREAD status. There is intentionally no update/delete surface: the only
 * mutation is the read transition (UNREAD → READ).
 */

const SELECT_COLUMNS = `id,
  client_id AS "clientId",
  recipient_user_id AS "recipientUserId",
  type,
  channel,
  status,
  title,
  body,
  source_entity_type AS "sourceEntityType",
  source_entity_id AS "sourceEntityId",
  source_event_type AS "sourceEventType",
  template_key AS "templateKey",
  metadata,
  navigation_target_type AS "navigationTargetType",
  navigation_target_id AS "navigationTargetId",
  created_at AS "createdAt",
  delivered_at AS "deliveredAt",
  read_at AS "readAt",
  updated_at AS "updatedAt"`;

function listWhere(recipientUserId: string, filters: NotificationFilters): {
  where: string;
  params: unknown[];
} {
  const params: unknown[] = [recipientUserId];
  const clauses = ['recipient_user_id = $1'];

  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }

  return { where: clauses.join(' AND '), params };
}

async function create(input: NewNotification): Promise<NotificationRecord> {
  const result = await getPool().query<NotificationRecord>(
    `INSERT INTO notifications (
       id, client_id, recipient_user_id, type, channel, status, title, body,
       source_entity_type, source_entity_id, source_event_type, template_key,
       metadata, navigation_target_type, navigation_target_id
     )
     VALUES ($1, $2, $3, $4, $5, 'UNREAD', $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${SELECT_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.recipientUserId,
      input.type,
      input.channel,
      input.title,
      input.body ?? null,
      input.sourceEntityType,
      input.sourceEntityId,
      input.sourceEventType ?? null,
      input.templateKey ?? null,
      input.metadata ?? {},
      // CR-BE-RN21-NOTIFICATION-NAV-01 — written ONLY from the producer's
      // explicit target, never inferred from the source entity fields.
      input.navigationTarget?.type ?? null,
      input.navigationTarget?.id ?? null,
    ],
  );
  return result.rows[0];
}

async function findById(
  recipientUserId: string,
  id: string,
): Promise<NotificationRecord | null> {
  const result = await getPool().query<NotificationRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notifications
      WHERE id = $1 AND recipient_user_id = $2`,
    [id, recipientUserId],
  );
  return result.rows[0] ?? null;
}

async function listByRecipient(
  recipientUserId: string,
  filters: NotificationFilters,
  limit?: number,
  offset?: number,
): Promise<NotificationRecord[]> {
  const { where, params } = listWhere(recipientUserId, filters);
  let sql = `SELECT ${SELECT_COLUMNS}
       FROM notifications
      WHERE ${where}
      ORDER BY created_at DESC, id DESC`;
  if (limit !== undefined) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }
  if (offset !== undefined) {
    params.push(offset);
    sql += ` OFFSET $${params.length}`;
  }
  const result = await getPool().query<NotificationRecord>(sql, params);
  return result.rows;
}

async function countByRecipient(
  recipientUserId: string,
  filters: NotificationFilters,
): Promise<number> {
  const { where, params } = listWhere(recipientUserId, filters);
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM notifications
      WHERE ${where}`,
    params,
  );
  return result.rows[0].n;
}

async function markRead(
  recipientUserId: string,
  id: string,
): Promise<NotificationRecord | null> {
  const result = await getPool().query<NotificationRecord>(
    `UPDATE notifications
        SET status = 'READ',
            read_at = COALESCE(read_at, NOW()),
            updated_at = NOW()
      WHERE id = $1 AND recipient_user_id = $2
      RETURNING ${SELECT_COLUMNS}`,
    [id, recipientUserId],
  );
  return result.rows[0] ?? null;
}

export const notificationRepository = {
  countByRecipient,
  create,
  findById,
  listByRecipient,
  markRead,
};
