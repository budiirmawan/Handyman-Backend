import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-INTEG-01 PART 03 — Webhook delivery ledger.
 *
 * One durable row per (outbox event, endpoint) — the claimable lifecycle
 * authority for one webhook delivery (governance §4), cloned from the proven
 * CR-BE-NOTIFY-PROV-01 notification ledger shape:
 *
 *   `PENDING → SENDING → DELIVERED / RETRY_SCHEDULED / FAILED_PERMANENT /
 *    EXHAUSTED`
 *
 * The payload bytes live on the referenced outbox row (serialized once,
 * byte-stable — §2.1); the ledger row snapshots the Client/Building +
 * event-type identity for isolation-safe reads and carries attempt
 * accounting. `UNIQUE (outbox_event_id, endpoint_id)` makes duplicate
 * fan-out structurally impossible. The delivery id doubles as the
 * receiver-facing idempotency key (§5/§6.1).
 *
 * No HTTP sending, signing, retry engine, or scheduler concern lives here
 * (PART 04+).
 */
export const migration0308CreateIntegrationWebhookDeliveries: Migration = {
  id: '0308_create_integration_webhook_deliveries',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE integration_webhook_deliveries (
        id                   UUID PRIMARY KEY,
        outbox_event_id      UUID NOT NULL REFERENCES integration_outbox_events (id),
        endpoint_id          UUID NOT NULL REFERENCES integration_webhook_endpoints (id),
        client_id            UUID NOT NULL REFERENCES clients (id),
        building_id          UUID REFERENCES buildings (id),
        event_type           TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'PENDING',
        attempt_count        INTEGER NOT NULL DEFAULT 0,
        max_attempts         INTEGER NOT NULL DEFAULT 5,
        next_retry_at        TIMESTAMPTZ,
        last_attempt_at      TIMESTAMPTZ,
        last_response_status INTEGER,
        last_error           TEXT,
        delivered_at         TIMESTAMPTZ,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT integration_webhook_deliveries_fanout_unique
          UNIQUE (outbox_event_id, endpoint_id),
        CONSTRAINT integration_webhook_deliveries_status_check
          CHECK (status IN ('PENDING', 'SENDING', 'DELIVERED',
                            'RETRY_SCHEDULED', 'FAILED_PERMANENT', 'EXHAUSTED')),
        CONSTRAINT integration_webhook_deliveries_max_attempts_check
          CHECK (max_attempts >= 1)
      )
    `);

    await client.query(`
      CREATE INDEX integration_webhook_deliveries_due_idx
        ON integration_webhook_deliveries
           (COALESCE(next_retry_at, '-infinity'::timestamptz), id)
        WHERE status IN ('PENDING', 'RETRY_SCHEDULED');
      CREATE INDEX integration_webhook_deliveries_endpoint_idx
        ON integration_webhook_deliveries (endpoint_id, created_at DESC);
      CREATE INDEX integration_webhook_deliveries_client_idx
        ON integration_webhook_deliveries (client_id, created_at DESC)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS integration_webhook_deliveries');
  },
};
