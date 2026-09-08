import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-26G — WhatsApp delivery attempt record.
 *
 * Records each outbound WhatsApp delivery attempt (adapter-ready; the 'noop'
 * adapter never sends a real message). The record captures:
 *
 *   - recipient reference (`recipient_user_id` + the resolved
 *     `recipient_phone` snapshot at send time),
 *   - the rendered message from the BE-26B template (`template_key`),
 *   - delivery status (SENT / FAILED),
 *   - `sent_at` (set on success),
 *   - `provider` / `provider_reference` (adapter + its response reference),
 *   - `error_message` (sanitized — never contains credentials/tokens).
 *
 * Client isolation is preserved via `client_id` (from the event/subscription
 * context); reads are recipient-scoped in the service layer.
 */
export const migration0242CreateNotificationWhatsappDeliveries: Migration = {
  id: '0242_create_notification_whatsapp_deliveries',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE notification_whatsapp_deliveries (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        recipient_user_id  UUID NOT NULL REFERENCES users (id),
        recipient_phone    TEXT NOT NULL,
        template_key       TEXT REFERENCES notification_templates (key),
        message_body       TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'FAILED',
        provider           TEXT NOT NULL,
        provider_reference TEXT,
        error_message      TEXT,
        sent_at            TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT notification_whatsapp_deliveries_status_check
          CHECK (status IN ('SENT', 'FAILED'))
      )
    `);

    await client.query(`
      CREATE INDEX notification_whatsapp_deliveries_recipient_idx
        ON notification_whatsapp_deliveries (recipient_user_id, created_at DESC);
      CREATE INDEX notification_whatsapp_deliveries_client_idx
        ON notification_whatsapp_deliveries (client_id, created_at DESC);
      CREATE INDEX notification_whatsapp_deliveries_status_idx
        ON notification_whatsapp_deliveries (status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS notification_whatsapp_deliveries');
  },
};
