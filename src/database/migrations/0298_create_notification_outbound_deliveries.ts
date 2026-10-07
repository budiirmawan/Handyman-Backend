import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-NOTIFY-PROV-01 PART 02 — outbound delivery ledger.
 *
 * One row = one outbound delivery intent for one (channel, recipient): the
 * durable lifecycle authority the START GOVERNANCE §3.4 defines. The existing
 * `notification_email_deliveries` / `notification_whatsapp_deliveries` tables
 * (BE-26F/G) remain the immutable per-attempt history; this ledger owns the
 * claimable lifecycle (PENDING → SENDING → SENT / RETRY_SCHEDULED /
 * FAILED_PERMANENT / EXHAUSTED) and the delivery-level idempotency key.
 *
 * WHY THE LEDGER EXISTS
 * ---------------------
 * Attempt tables are append-only terminal records (SENT / FAILED) with no
 * retry window, no attempt counter, and no duplicate guard — governance §2
 * gaps G3/G5. The ledger snapshots the rendered content once at intent time
 * (SLA-02 snapshot-on-schedule precedent), so template edits can never
 * rewrite an in-flight delivery, and carries the provider result fields
 * (`provider`, `provider_message_id`, `last_error`) across attempts.
 *
 * IDEMPOTENCY
 * -----------
 * `UNIQUE (client_id, channel, idempotency_key)` is the durable duplicate
 * guard (governance §7.1): a replayed intent inserts nothing and the
 * repository returns the existing row. The key itself is computed by the
 * idempotency authority in `src/modules/notification-outbound-deliveries`.
 *
 * SIZE CAPS (governance R-08)
 * ---------------------------
 * The content snapshot is bounded: subject ≤ 500, message ≤ 4000,
 * recipient address ≤ 320, last_error ≤ 500 — operational messages only,
 * never unbounded payloads.
 *
 * BOUNDARY
 * --------
 * No existing table is modified here (the additive `delivery_id` attempt
 * linkage arrives in migration 0299). No orchestration, retry engine, or
 * scheduler wiring — those are PART 03/04.
 */
export const migration0298CreateNotificationOutboundDeliveries: Migration = {
  id: '0298_create_notification_outbound_deliveries',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE notification_outbound_deliveries (
        id                  UUID PRIMARY KEY,
        client_id           UUID NOT NULL REFERENCES clients (id),
        building_id         UUID REFERENCES buildings (id),
        recipient_user_id   UUID NOT NULL REFERENCES users (id),
        channel             TEXT NOT NULL,
        template_key        TEXT REFERENCES notification_templates (key),
        source_event_type   TEXT NOT NULL,
        source_entity_type  TEXT NOT NULL,
        source_entity_id    UUID NOT NULL,
        subject             TEXT,
        message             TEXT NOT NULL,
        recipient_address   TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'PENDING',
        attempt_count       INTEGER NOT NULL DEFAULT 0,
        max_attempts        INTEGER NOT NULL DEFAULT 5,
        next_retry_at       TIMESTAMPTZ,
        last_attempt_at     TIMESTAMPTZ,
        provider            TEXT,
        provider_message_id TEXT,
        last_error          TEXT,
        idempotency_key     TEXT NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT notification_outbound_deliveries_channel_check
          CHECK (channel IN ('EMAIL', 'WHATSAPP')),
        CONSTRAINT notification_outbound_deliveries_status_check
          CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'RETRY_SCHEDULED',
                            'FAILED_PERMANENT', 'EXHAUSTED')),
        CONSTRAINT notification_outbound_deliveries_idempotency_unique
          UNIQUE (client_id, channel, idempotency_key),
        CONSTRAINT notification_outbound_deliveries_max_attempts_check
          CHECK (max_attempts >= 1),
        CONSTRAINT notification_outbound_deliveries_attempt_count_check
          CHECK (attempt_count >= 0),
        CONSTRAINT notification_outbound_deliveries_subject_length_check
          CHECK (subject IS NULL OR char_length(subject) <= 500),
        CONSTRAINT notification_outbound_deliveries_message_length_check
          CHECK (char_length(message) <= 4000),
        CONSTRAINT notification_outbound_deliveries_address_length_check
          CHECK (char_length(recipient_address) <= 320),
        CONSTRAINT notification_outbound_deliveries_last_error_length_check
          CHECK (last_error IS NULL OR char_length(last_error) <= 500),
        CONSTRAINT notification_outbound_deliveries_event_type_length_check
          CHECK (char_length(source_event_type) <= 128),
        CONSTRAINT notification_outbound_deliveries_entity_type_length_check
          CHECK (char_length(source_entity_type) <= 128)
      )
    `);

    await client.query(`
      CREATE INDEX notification_outbound_deliveries_due_idx
        ON notification_outbound_deliveries
           (COALESCE(next_retry_at, '-infinity'::timestamptz), id)
        WHERE status IN ('PENDING', 'RETRY_SCHEDULED');
      CREATE INDEX notification_outbound_deliveries_recipient_idx
        ON notification_outbound_deliveries (recipient_user_id, created_at DESC);
      CREATE INDEX notification_outbound_deliveries_client_idx
        ON notification_outbound_deliveries (client_id, created_at DESC);
      CREATE INDEX notification_outbound_deliveries_source_idx
        ON notification_outbound_deliveries
           (source_entity_type, source_entity_id, created_at DESC)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS notification_outbound_deliveries');
  },
};
