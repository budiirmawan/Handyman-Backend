import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-26H — Notification reminder foundation.
 *
 * A reminder is a time-deferred notification trigger: at `reminder_at`, the
 * reminder triggers in-app notification delivery (BE-26A/B/C/E) to its
 * recipients. The reminder only TRIGGERS delivery — the source domain
 * remains authoritative and no workflow logic is duplicated.
 *
 *   - `key`             — stable, unique reminder reference (uppercase code),
 *   - `source_entity_type` / `source_entity_id` — the source/resource being
 *     reminded about (the authoritative domain entity),
 *   - `recipient_rule`  — the BE-26C recipient resolution rule,
 *   - `template_key`    — the BE-26B template rendered at dispatch time,
 *   - `reminder_at`     — when the reminder becomes due,
 *   - `variables`       — template variable values snapshot,
 *   - `status`          — PENDING / SENT / CANCELLED,
 *   - `sent_at`         — set when the reminder was dispatched.
 *
 * NO scheduler engine is created: this table is the durable record, and the
 * service exposes `findDueReminders` / `dispatchDueReminders` seams that an
 * external scheduler/worker (future part) can invoke.
 */
export const migration0243CreateNotificationReminders: Migration = {
  id: '0243_create_notification_reminders',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE notification_reminders (
        id                 UUID PRIMARY KEY,
        key                TEXT NOT NULL,
        client_id          UUID NOT NULL REFERENCES clients (id),
        source_entity_type TEXT NOT NULL,
        source_entity_id   UUID NOT NULL,
        recipient_rule     JSONB NOT NULL DEFAULT '{}'::jsonb,
        template_key       TEXT NOT NULL REFERENCES notification_templates (key),
        variables          JSONB NOT NULL DEFAULT '{}'::jsonb,
        reminder_at        TIMESTAMPTZ NOT NULL,
        status             TEXT NOT NULL DEFAULT 'PENDING',
        sent_at            TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT notification_reminders_key_unique UNIQUE (key),
        CONSTRAINT notification_reminders_status_check
          CHECK (status IN ('PENDING', 'SENT', 'CANCELLED'))
      )
    `);

    await client.query(`
      CREATE INDEX notification_reminders_due_idx
        ON notification_reminders (status, reminder_at);
      CREATE INDEX notification_reminders_client_idx
        ON notification_reminders (client_id, created_at DESC);
      CREATE INDEX notification_reminders_source_idx
        ON notification_reminders (source_entity_type, source_entity_id, status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS notification_reminders');
  },
};
