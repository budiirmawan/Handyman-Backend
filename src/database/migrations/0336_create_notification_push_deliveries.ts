import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-PUSH-01 PART 03C — per-device push attempt evidence.
 *
 * GOVERNANCE: docs/CR-BE-PUSH-01_START_GOVERNANCE.md §12.7 (reserved number
 * `0336`), §10.2 (one ledger row per recipient + N per-device attempt rows),
 * §8 (invalid-token evidence retention).
 *
 * SHAPE IS FROZEN, NOT INVENTED. The column list below is transcribed from
 * the governance §12.7 proposal, which is itself shaped after the BE-26F
 * email attempt table (migration 0241). Nothing was added beyond it and
 * nothing was dropped from it.
 *
 * WHY A SEPARATE TABLE (§10.2)
 * ----------------------------
 * EMAIL and WhatsApp have exactly one address per recipient, so one ledger
 * row maps to one attempt row. Push does not: one recipient owns N devices,
 * and each device gets its own provider call with its own outcome. Recording
 * those N results on the single ledger row would destroy per-device evidence
 * ("which handset stopped receiving, and why?"). The ledger keeps ONE row per
 * recipient; this table holds the per-device attempts underneath it.
 *
 * NO TOKEN VALUE COLUMN (§12.7)
 * -----------------------------
 * The provider token is deliberately absent. It is reachable via
 * `push_token_id`, so the forensic linkage is preserved without copying a
 * device credential into a second table with a different retention profile.
 *
 * APPEND-ONLY. Like 0241, a recorded attempt is immutable: the repository
 * exposes no update and no delete. `delivery_id` is `ON DELETE SET NULL`
 * (the 0299 precedent) so archiving a ledger row never destroys the evidence
 * of what was actually sent to a device.
 */
export const migration0336CreateNotificationPushDeliveries: Migration = {
  id: '0336_create_notification_push_deliveries',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE notification_push_deliveries (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        building_id        UUID REFERENCES buildings (id),
        recipient_user_id  UUID NOT NULL REFERENCES users (id),
        push_token_id      UUID NOT NULL REFERENCES mobile_push_tokens (id),
        device_id          TEXT NOT NULL,
        platform           TEXT NOT NULL,
        template_key       TEXT REFERENCES notification_templates (key),
        title              TEXT NOT NULL,
        body               TEXT,
        status             TEXT NOT NULL DEFAULT 'FAILED',
        provider           TEXT NOT NULL,
        provider_reference TEXT,
        error_message      TEXT,
        error_code         TEXT,
        sent_at            TIMESTAMPTZ,
        delivery_id        UUID REFERENCES notification_outbound_deliveries (id)
                             ON DELETE SET NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT notification_push_deliveries_status_check
          CHECK (status IN ('SENT', 'FAILED')),
        CONSTRAINT notification_push_deliveries_platform_check
          CHECK (platform IN ('ANDROID', 'IOS')),
        CONSTRAINT notification_push_deliveries_title_length_check
          CHECK (char_length(title) <= 200),
        CONSTRAINT notification_push_deliveries_body_length_check
          CHECK (body IS NULL OR char_length(body) <= 500),
        CONSTRAINT notification_push_deliveries_error_length_check
          CHECK (error_message IS NULL OR char_length(error_message) <= 500)
      )
    `);

    // Recipient-scoped history reads, client-scoped operational review, the
    // per-ledger-row fan-out rollup, and per-device failure forensics.
    await client.query(`
      CREATE INDEX notification_push_deliveries_recipient_idx
        ON notification_push_deliveries (recipient_user_id, created_at DESC);
      CREATE INDEX notification_push_deliveries_client_idx
        ON notification_push_deliveries (client_id, created_at DESC);
      CREATE INDEX notification_push_deliveries_delivery_idx
        ON notification_push_deliveries (delivery_id);
      CREATE INDEX notification_push_deliveries_token_idx
        ON notification_push_deliveries (push_token_id, created_at DESC)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS notification_push_deliveries');
  },
};
