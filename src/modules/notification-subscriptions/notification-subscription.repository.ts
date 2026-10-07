import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateNotificationEventSubscriptionInput,
  NotificationEventSubscriptionRecord,
  UpdateNotificationEventSubscriptionInput,
} from './notification-subscription.types';

/**
 * BE-26D — Notification event subscription repository.
 *
 * Append-only by lifecycle: deactivation sets `status: 'INACTIVE'` (enabled
 * flag off); rows are never hard-deleted through the foundation. JSONB rule
 * values follow the repo convention (JSON.stringify + ::jsonb).
 */

const SELECT_COLUMNS = `id,
  key,
  event_type AS "eventType",
  template_key AS "templateKey",
  recipient_rule AS "recipientRule",
  client_id AS "clientId",
  building_id AS "buildingId",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

async function create(
  input: CreateNotificationEventSubscriptionInput,
): Promise<NotificationEventSubscriptionRecord> {
  const result = await getPool().query<NotificationEventSubscriptionRecord>(
    `INSERT INTO notification_event_subscriptions (
       id, key, event_type, template_key, recipient_rule, client_id,
       building_id, status
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     RETURNING ${SELECT_COLUMNS}`,
    [
      randomUUID(),
      input.key,
      input.eventType,
      input.templateKey,
      JSON.stringify(input.recipientRule),
      input.clientId ?? null,
      input.buildingId ?? null,
      input.status ?? 'ACTIVE',
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
): Promise<NotificationEventSubscriptionRecord | null> {
  const result = await getPool().query<NotificationEventSubscriptionRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_event_subscriptions
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByKey(
  key: string,
): Promise<NotificationEventSubscriptionRecord | null> {
  const result = await getPool().query<NotificationEventSubscriptionRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_event_subscriptions
      WHERE key = $1`,
    [key],
  );
  return result.rows[0] ?? null;
}

async function list(
  status?: NotificationEventSubscriptionRecord['status'],
): Promise<NotificationEventSubscriptionRecord[]> {
  const params: unknown[] = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE status = $1';
  }
  const result = await getPool().query<NotificationEventSubscriptionRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_event_subscriptions
       ${where}
       ORDER BY key ASC, id ASC`,
    params,
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateNotificationEventSubscriptionInput,
): Promise<NotificationEventSubscriptionRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [field, column] of [
    ['eventType', 'event_type'],
    ['templateKey', 'template_key'],
    ['status', 'status'],
  ] as const) {
    if (input[field] !== undefined) {
      params.push(input[field]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (input.recipientRule !== undefined) {
    params.push(JSON.stringify(input.recipientRule));
    sets.push(`recipient_rule = $${params.length}::jsonb`);
  }
  if (input.clientId !== undefined) {
    params.push(input.clientId);
    sets.push(`client_id = $${params.length}`);
  }
  if (input.buildingId !== undefined) {
    params.push(input.buildingId);
    sets.push(`building_id = $${params.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  params.push(id);
  const result = await getPool().query<NotificationEventSubscriptionRecord>(
    `UPDATE notification_event_subscriptions
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length}
      RETURNING ${SELECT_COLUMNS}`,
    params,
  );
  return result.rows[0] ?? null;
}

/**
 * Maps an occurred domain event to its ACTIVE subscriptions, honoring the
 * Client/Building context (NULL context on a subscription = wildcard).
 * A context dimension is only filtered when supplied; a subscription with
 * NULL context matches any value of that dimension.
 * The lookup seam BE-26E consumes — no delivery happens here.
 */
async function findMatching(
  eventType: string,
  clientId?: string,
  buildingId?: string,
): Promise<NotificationEventSubscriptionRecord[]> {
  const clauses = [`status = 'ACTIVE'`, `event_type = $1`];
  const params: unknown[] = [eventType];

  if (clientId) {
    params.push(clientId);
    clauses.push(`(client_id IS NULL OR client_id = $${params.length}::uuid)`);
  }
  if (buildingId) {
    params.push(buildingId);
    clauses.push(`(building_id IS NULL OR building_id = $${params.length}::uuid)`);
  }

  const result = await getPool().query<NotificationEventSubscriptionRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_event_subscriptions
      WHERE ${clauses.join(' AND ')}
      ORDER BY key ASC, id ASC`,
    params,
  );
  return result.rows;
}

export const notificationSubscriptionRepository = {
  create,
  findById,
  findByKey,
  findMatching,
  list,
  update,
};
