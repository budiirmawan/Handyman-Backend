import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-26E — In-App delivery columns on the notification record.
 *
 * Extends the BE-26A `notifications` record (which IS the in-app delivery
 * record) with:
 *   - `template_key`  — the BE-26B template that rendered this notification
 *     (nullable: BE-26A direct creations carry no template),
 *   - `delivered_at`  — when the in-app delivery became visible to the
 *     recipient (defaults to creation time for the in-app channel).
 *
 * Read/unread state and `read_at` already exist on `notifications` (BE-26A).
 * No email / WhatsApp / push delivery state is introduced here.
 */
export const migration0240AddNotificationDeliveryColumns: Migration = {
  id: '0240_add_notification_delivery_columns',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE notifications
        ADD COLUMN template_key TEXT,
        ADD COLUMN delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    await client.query(`
      ALTER TABLE notifications
        ADD CONSTRAINT notifications_template_key_fkey
          FOREIGN KEY (template_key) REFERENCES notification_templates (key)
    `);

    await client.query(`
      CREATE INDEX notifications_delivered_at_idx
        ON notifications (delivered_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE notifications DROP COLUMN IF EXISTS delivered_at
    `);
    await client.query(`
      ALTER TABLE notifications DROP COLUMN IF EXISTS template_key CASCADE
    `);
  },
};
