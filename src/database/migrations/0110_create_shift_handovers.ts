import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-10J — Shift Handover.
 *
 * The minimal Engineering shift handover record: an outgoing BE-03 Shift, an
 * incoming BE-03 Shift, the handover date, a preparer, an optional
 * acknowledger, a summary, and a DRAFT → READY → ACKNOWLEDGED lifecycle.
 *
 * The operational content of a handover is NEVER copied into this table —
 * it is resolved live from the authoritative BE-07/08/09/10 records at read
 * time. Only the summary text and the identity/status fields are stored, for
 * handover traceability.
 *
 * `client_id` / `building_id` are stored directly but derived authoritatively
 * by the service from the Shifts' Building → Property → Client, so isolation
 * can never drift from BE-02. Outgoing and incoming Shifts must differ and
 * both must belong to the same Building (service-enforced; the CHECK here is
 * the schema backstop).
 */
export const migration0110CreateShiftHandovers: Migration = {
  id: '0110_create_shift_handovers',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE shift_handovers (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        building_id              UUID NOT NULL REFERENCES buildings (id),
        outgoing_shift_id        UUID NOT NULL REFERENCES shifts (id),
        incoming_shift_id        UUID NOT NULL REFERENCES shifts (id),
        handover_date            DATE NOT NULL,
        prepared_by_user_id      UUID NOT NULL REFERENCES users (id),
        acknowledged_by_user_id  UUID REFERENCES users (id),
        summary                  TEXT,
        status                   TEXT NOT NULL DEFAULT 'DRAFT',
        prepared_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        acknowledged_at          TIMESTAMPTZ,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT shift_handover_status
          CHECK (status IN ('DRAFT', 'READY', 'ACKNOWLEDGED')),
        CONSTRAINT shift_handover_shifts_differ
          CHECK (outgoing_shift_id <> incoming_shift_id)
      )
    `);

    await client.query(`
      CREATE INDEX shift_handovers_building_date_idx
        ON shift_handovers (building_id, handover_date DESC);
      CREATE INDEX shift_handovers_outgoing_idx
        ON shift_handovers (outgoing_shift_id);
      CREATE INDEX shift_handovers_incoming_idx
        ON shift_handovers (incoming_shift_id);
      CREATE INDEX shift_handovers_status_idx
        ON shift_handovers (status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS shift_handovers');
  },
};
