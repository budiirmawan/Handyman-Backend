import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-26F — Email delivery attempt record.
 *
 * Records each outbound email delivery attempt (adapter-ready; the 'noop'
 * adapter never sends real email). The record captures:
 *
 *   - recipient reference (`recipient_user_id` + the resolved `recipient_email`
 *     snapshot at send time),
 *   - the rendered subject/body from the BE-26B template (`template_key`),
 *   - delivery status (SENT / FAILED),
 *   - `sent_at` (set on success),
 *   - `provider` / `provider_reference` (adapter + its response reference),
 *   - `error_message` (sanitized — never contains credentials).
 *
 * Client isolation is preserved via `client_id` (from the event/subscription
 * context); reads are recipient-scoped in the service layer.
 */
export const migration0241CreateNotificationEmailDeliveries: Migration = {
  id: '0241_create_notification_email_deliveries',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE notification_email_deliveries (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        recipient_user_id  UUID NOT NULL REFERENCES users (id),
        recipient_email    TEXT NOT NULL,
        template_key       TEXT REFERENCES notification_templates (key),
        subject            TEXT NOT NULL,
        body               TEXT,
        status             TEXT NOT NULL DEFAULT 'FAILED',
        provider           TEXT NOT NULL,
        provider_reference TEXT,
        error_message      TEXT,
        sent_at            TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT notification_email_deliveries_status_check
          CHECK (status IN ('SENT', 'FAILED'))
      )
    `);

    await client.query(`
      CREATE INDEX notification_email_deliveries_recipient_idx
        ON notification_email_deliveries (recipient_user_id, created_at DESC);
      CREATE INDEX notification_email_deliveries_client_idx
        ON notification_email_deliveries (client_id, created_at DESC);
      CREATE INDEX notification_email_deliveries_status_idx
        ON notification_email_deliveries (status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS notification_email_deliveries');
  },
};
