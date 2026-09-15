import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-INTEG-01 PART 01 — Transactional outbox foundation.
 *
 * `integration_outbox_events` is a THIN integration marker over the BE-07
 * business-event authority (governance §2): `operational_events` remains the
 * only source of truth for what happened; an outbox row only means "this one
 * event is pending outbound integration fan-out" and carries:
 *
 *   - `operational_event_id` — UNIQUE FK reference to the authoritative
 *     event (one outbox row per event: duplicate fan-out is structurally
 *     impossible),
 *   - Client/Building + event/entity identity copied from the event so
 *     fan-out (PART 03) matches endpoints without joining the event table,
 *   - `payload` — the canonical delivery envelope serialized EXACTLY ONCE at
 *     enqueue time and stored as TEXT (byte-stable: the future HMAC signs
 *     these bytes; JSONB round-trips do not preserve them),
 *   - `status` — the fan-out lifecycle only (`PENDING → PROCESSING →
 *     PROCESSED / FAILED`). Per-endpoint delivery lifecycle lives on the
 *     PART 03 delivery ledger, never here.
 *
 * No webhook endpoint, secret, delivery, HTTP, retry, or scheduler concern
 * exists in this migration.
 */
export const migration0306CreateIntegrationOutboxEvents: Migration = {
  id: '0306_create_integration_outbox_events',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE integration_outbox_events (
        id                   UUID PRIMARY KEY,
        operational_event_id UUID NOT NULL REFERENCES operational_events (id),
        client_id            UUID NOT NULL REFERENCES clients (id),
        building_id          UUID REFERENCES buildings (id),
        event_type           TEXT NOT NULL,
        entity_type          TEXT NOT NULL,
        entity_id            UUID NOT NULL,
        payload              TEXT NOT NULL,
        occurred_at          TIMESTAMPTZ NOT NULL,
        status               TEXT NOT NULL DEFAULT 'PENDING',
        processed_at         TIMESTAMPTZ,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT integration_outbox_events_operational_event_unique
          UNIQUE (operational_event_id),
        CONSTRAINT integration_outbox_events_status_check
          CHECK (status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED'))
      )
    `);

    await client.query(`
      CREATE INDEX integration_outbox_events_due_idx
        ON integration_outbox_events (status, created_at);
      CREATE INDEX integration_outbox_events_client_idx
        ON integration_outbox_events (client_id, created_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS integration_outbox_events');
  },
};
