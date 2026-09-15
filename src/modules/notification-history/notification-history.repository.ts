import { getPool } from '../../database';
import type {
  NotificationHistoryChannel,
  NotificationHistoryFilters,
  NotificationHistoryRow,
} from './notification-history.types';

/**
 * BE-26K — Notification history repository (read-only).
 *
 * Unifies the existing delivery records into a single chronological view via
 * a UNION ALL across the in-app (BE-26E), email (BE-26F) and WhatsApp
 * (BE-26G) delivery tables. No rows are written here — this is a read model,
 * not a second audit engine.
 *
 * Field mapping per channel:
 *   - IN_APP    → status UNREAD/READ; sentAt/deliveredAt = delivered_at;
 *                 readAt = read_at; source refs present.
 *   - EMAIL     → status SENT/FAILED; sentAt = sent_at; failedAt = created_at
 *                 when FAILED; provider/providerReference/failureReason present.
 *   - WHATSAPP  → same as EMAIL.
 */

/**
 * The union sub-query. `$1` is the recipient user id (reused across branches).
 */
const UNION_SELECT = `
  SELECT
    'IN_APP' AS channel,
    n.id,
    n.client_id AS "clientId",
    n.recipient_user_id AS "recipientUserId",
    n.type,
    n.template_key AS "templateKey",
    n.source_entity_type AS "sourceEntityType",
    n.source_entity_id AS "sourceEntityId",
    n.source_event_type AS "sourceEventType",
    n.status,
    n.delivered_at AS "sentAt",
    n.delivered_at AS "deliveredAt",
    NULL::timestamptz AS "failedAt",
    n.read_at AS "readAt",
    NULL::text AS "provider",
    NULL::text AS "providerReference",
    NULL::text AS "failureReason",
    NULL::uuid AS "deliveryId",
    NULL::text AS "providerFeedbackStatus",
    NULL::timestamptz AS "feedbackAt",
    n.created_at AS "createdAt",
    COALESCE(n.delivered_at, n.created_at) AS "occurredAt"
  FROM notifications n
  WHERE n.recipient_user_id = $1

  UNION ALL

  SELECT
    'EMAIL' AS channel,
    e.id,
    e.client_id AS "clientId",
    e.recipient_user_id AS "recipientUserId",
    NULL::text AS type,
    e.template_key AS "templateKey",
    NULL::text AS "sourceEntityType",
    NULL::uuid AS "sourceEntityId",
    NULL::text AS "sourceEventType",
    e.status,
    e.sent_at AS "sentAt",
    NULL::timestamptz AS "deliveredAt",
    CASE WHEN e.status = 'FAILED' THEN e.created_at END AS "failedAt",
    NULL::timestamptz AS "readAt",
    e.provider,
    e.provider_reference AS "providerReference",
    e.error_message AS "failureReason",
    e.delivery_id AS "deliveryId",
    el.provider_feedback_status AS "providerFeedbackStatus",
    el.feedback_at AS "feedbackAt",
    e.created_at AS "createdAt",
    COALESCE(e.sent_at, e.created_at) AS "occurredAt"
  FROM notification_email_deliveries e
  LEFT JOIN notification_outbound_deliveries el ON el.id = e.delivery_id
  WHERE e.recipient_user_id = $1

  UNION ALL

  SELECT
    'WHATSAPP' AS channel,
    w.id,
    w.client_id AS "clientId",
    w.recipient_user_id AS "recipientUserId",
    NULL::text AS type,
    w.template_key AS "templateKey",
    NULL::text AS "sourceEntityType",
    NULL::uuid AS "sourceEntityId",
    NULL::text AS "sourceEventType",
    w.status,
    w.sent_at AS "sentAt",
    NULL::timestamptz AS "deliveredAt",
    CASE WHEN w.status = 'FAILED' THEN w.created_at END AS "failedAt",
    NULL::timestamptz AS "readAt",
    w.provider,
    w.provider_reference AS "providerReference",
    w.error_message AS "failureReason",
    w.delivery_id AS "deliveryId",
    wl.provider_feedback_status AS "providerFeedbackStatus",
    wl.feedback_at AS "feedbackAt",
    w.created_at AS "createdAt",
    COALESCE(w.sent_at, w.created_at) AS "occurredAt"
  FROM notification_whatsapp_deliveries w
  LEFT JOIN notification_outbound_deliveries wl ON wl.id = w.delivery_id
  WHERE w.recipient_user_id = $1
`;

/** The outer WHERE clause applied to the union (channel/status filters). */
const OUTER_WHERE = `
  WHERE ($2::text IS NULL OR h.channel = $2::text)
    AND ($3::text IS NULL OR h.status = $3::text)
`;

async function listByRecipient(
  recipientUserId: string,
  filters: NotificationHistoryFilters,
  limit?: number,
  offset?: number,
): Promise<NotificationHistoryRow[]> {
  const params: unknown[] = [
    recipientUserId,
    filters.channel ?? null,
    filters.status ?? null,
  ];
  let sql = `SELECT * FROM (${UNION_SELECT}) AS h${OUTER_WHERE}
     ORDER BY h."occurredAt" DESC, h.id DESC`;
  if (limit !== undefined) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }
  if (offset !== undefined) {
    params.push(offset);
    sql += ` OFFSET $${params.length}`;
  }
  const result = await getPool().query<NotificationHistoryRow>(sql, params);
  return result.rows;
}

async function countByRecipient(
  recipientUserId: string,
  filters: NotificationHistoryFilters,
): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM (${UNION_SELECT}) AS h${OUTER_WHERE}`,
    [recipientUserId, filters.channel ?? null, filters.status ?? null],
  );
  return result.rows[0].n;
}

async function findById(
  recipientUserId: string,
  channel: NotificationHistoryChannel,
  id: string,
): Promise<NotificationHistoryRow | null> {
  const result = await getPool().query<NotificationHistoryRow>(
    `SELECT * FROM (${UNION_SELECT}) AS h
      WHERE h.channel = $2::text
        AND h.id = $3::uuid`,
    [recipientUserId, channel, id],
  );
  return result.rows[0] ?? null;
}

export const notificationHistoryRepository = {
  countByRecipient,
  findById,
  listByRecipient,
};
