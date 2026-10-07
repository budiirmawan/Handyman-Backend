import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-26B — Notification template foundation.
 *
 * A notification template is a platform-level, reusable rendering recipe
 * (the "what to say" for a notification type). It is deliberately separated
 * from recipient resolution (BE-26C) and from delivery (later BE-26 parts):
 * this table stores ONLY the template key/type/channel/subject/body and the
 * declared template variables.
 *
 * - `key`   — stable, unique template identifier (uppercase code).
 * - `type`  — the notification type stamped on rendered notifications.
 * - `channel` — only IN_APP in this foundation (push/email arrive later).
 * - `subject` / `body` — templates with `{{variable}}` placeholders.
 * - `variables` — JSON array of declared variable names (the template's
 *   supported substitution set).
 * - `status` — ACTIVE / INACTIVE (deactivation never hard-deletes).
 *
 * Templates are platform configuration (like permissions), not per-Client:
 * Client / Building isolation is preserved at the NOTIFICATION level
 * (BE-26A `notifications.client_id`) when a template is rendered, not here.
 */
export const migration0238CreateNotificationTemplates: Migration = {
  id: '0238_create_notification_templates',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE notification_templates (
        id         UUID PRIMARY KEY,
        key        TEXT NOT NULL,
        type       TEXT NOT NULL,
        channel    TEXT NOT NULL,
        subject    TEXT NOT NULL,
        body       TEXT,
        variables  JSONB NOT NULL DEFAULT '[]'::jsonb,
        status     TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT notification_templates_key_unique UNIQUE (key),
        CONSTRAINT notification_templates_channel_check
          CHECK (channel IN ('IN_APP')),
        CONSTRAINT notification_templates_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX notification_templates_status_idx
        ON notification_templates (status, key)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS notification_templates');
  },
};
