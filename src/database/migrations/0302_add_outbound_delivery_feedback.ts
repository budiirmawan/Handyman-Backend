import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-NOTIFY-PROV-01 PART 07 — delivery feedback vocabulary + correlation.
 *
 * Strictly additive on the PART 02 outbound delivery ledger:
 *
 *   - feedback columns: `provider_feedback_status` (governed vocabulary
 *     DELIVERED | BOUNCED | COMPLAINT | PROVIDER_FAILED — the WhatsApp path
 *     uses DELIVERED / PROVIDER_FAILED; BOUNCED / COMPLAINT are reserved for
 *     a future email feedback path), `feedback_at`, `feedback_error`
 *     (sanitized, ≤ 500 chars);
 *   - the provider-message-id correlation index required by the callback
 *     seam (PART 06 stores the Meta `wamid` in `provider_message_id`).
 *
 * Feedback is POST-ACCEPTANCE and never reopens the send lifecycle: the
 * send-path `status` column and the immutable attempt-history tables are
 * untouched. Transitions are guarded in the repository (from SENT only,
 * first feedback wins), so duplicates and out-of-order callbacks are no-ops.
 */
export const migration0302AddOutboundDeliveryFeedback: Migration = {
  id: '0302_add_outbound_delivery_feedback',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE notification_outbound_deliveries
        ADD COLUMN provider_feedback_status TEXT,
        ADD COLUMN feedback_at TIMESTAMPTZ,
        ADD COLUMN feedback_error TEXT
    `);

    await client.query(`
      ALTER TABLE notification_outbound_deliveries
        ADD CONSTRAINT notification_outbound_deliveries_feedback_status_check
          CHECK (provider_feedback_status IS NULL
                 OR provider_feedback_status IN ('DELIVERED', 'BOUNCED',
                                                 'COMPLAINT', 'PROVIDER_FAILED'))
    `);

    await client.query(`
      ALTER TABLE notification_outbound_deliveries
        ADD CONSTRAINT notification_outbound_deliveries_feedback_error_length_check
          CHECK (feedback_error IS NULL OR char_length(feedback_error) <= 500)
    `);

    await client.query(`
      CREATE INDEX notification_outbound_deliveries_provider_message_idx
        ON notification_outbound_deliveries (provider_message_id)
        WHERE provider_message_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP INDEX IF EXISTS notification_outbound_deliveries_provider_message_idx',
    );
    await client.query(`
      ALTER TABLE notification_outbound_deliveries
        DROP COLUMN IF EXISTS feedback_error,
        DROP COLUMN IF EXISTS feedback_at,
        DROP COLUMN IF EXISTS provider_feedback_status
    `);
  },
};
