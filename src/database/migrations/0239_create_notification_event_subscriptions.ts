import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-26D — Notification event subscription foundation.
 *
 * Maps existing backend domain events (BE-07 `operational_events.event_type`)
 * to notification triggers. A subscription is DECLARATIVE configuration —
 * the business domains remain the source of truth; this table only reacts:
 *
 *   - `key`           — stable, unique subscription key (uppercase code),
 *   - `event_type`    — the existing domain event type to react to,
 *   - `template_key`  — the BE-26B notification template to render,
 *   - `recipient_rule`— the BE-26C recipient resolution rule ({ specs, scope? }),
 *   - `client_id` / `building_id` — optional Client/Building context
 *     (NULL = wildcard; set = only events in that context),
 *   - `status`        — ACTIVE / INACTIVE (enabled flag).
 *
 * No delivery and no in-app/push/email execution happen here (BE-26E). No new
 * domain events are created by this table.
 */
export const migration0239CreateNotificationEventSubscriptions: Migration = {
  id: '0239_create_notification_event_subscriptions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE notification_event_subscriptions (
        id             UUID PRIMARY KEY,
        key            TEXT NOT NULL,
        event_type     TEXT NOT NULL,
        template_key   TEXT NOT NULL REFERENCES notification_templates (key),
        recipient_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
        client_id      UUID REFERENCES clients (id),
        building_id    UUID REFERENCES buildings (id),
        status         TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT notification_event_subscriptions_key_unique UNIQUE (key),
        CONSTRAINT notification_event_subscriptions_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX notification_event_subscriptions_event_idx
        ON notification_event_subscriptions (event_type, status);
      CREATE INDEX notification_event_subscriptions_client_idx
        ON notification_event_subscriptions (client_id);
      CREATE INDEX notification_event_subscriptions_building_idx
        ON notification_event_subscriptions (building_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS notification_event_subscriptions');
  },
};
