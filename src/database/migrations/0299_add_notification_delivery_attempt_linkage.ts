import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-NOTIFY-PROV-01 PART 02 — attempt history ↔ ledger linkage.
 *
 * Additive only: the existing BE-26F/G attempt tables
 * (`notification_email_deliveries`, `notification_whatsapp_deliveries`)
 * remain the immutable per-attempt history. Each gains one nullable
 * `delivery_id` foreign key to the PART 02 outbound delivery ledger so an
 * attempt can be tied back to the claimable lifecycle row that produced it.
 *
 * Nullable by design: every attempt recorded before PART 02 (the noop era,
 * and any future adapter-injected send outside the ledger) keeps its meaning
 * with `delivery_id = NULL`. `ON DELETE SET NULL` preserves the immutable
 * history even if a ledger row were ever removed.
 */
export const migration0299AddNotificationDeliveryAttemptLinkage: Migration = {
  id: '0299_add_notification_delivery_attempt_linkage',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE notification_email_deliveries
        ADD COLUMN delivery_id UUID REFERENCES notification_outbound_deliveries (id)
          ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX notification_email_deliveries_delivery_idx
        ON notification_email_deliveries (delivery_id)
    `);

    await client.query(`
      ALTER TABLE notification_whatsapp_deliveries
        ADD COLUMN delivery_id UUID REFERENCES notification_outbound_deliveries (id)
          ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX notification_whatsapp_deliveries_delivery_idx
        ON notification_whatsapp_deliveries (delivery_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE notification_whatsapp_deliveries DROP COLUMN IF EXISTS delivery_id
    `);
    await client.query(`
      ALTER TABLE notification_email_deliveries DROP COLUMN IF EXISTS delivery_id
    `);
  },
};
