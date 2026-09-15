import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-13G — Check-In.
 *
 * The backend-authoritative check-in record for a BE-13 visit context —
 * an Expected Visitor (BE-13C) or a Walk-In / Guest Book entry
 * (BE-13D), referenced by EXACTLY ONE FK (CHECK enforced). Reuses the
 * shared visitor identity through the visit; no visitor data is
 * duplicated.
 *
 * Confirmation gate: when a BE-13F host confirmation exists for the
 * visit it must be CONFIRMED — PENDING or REJECTED confirmations block
 * the check-in (service-enforced). A visit without any confirmation
 * record may check in (confirmation is not mandatory in the current
 * domain).
 *
 * Duplicate rule: at most ONE active (CHECKED_IN) check-in per visit —
 * partial unique index per visit FK. A CANCELLED (mistake-reversal)
 * check-in never blocks a fresh one.
 *
 * Lifecycle (minimal): CHECKED_IN → CANCELLED (front-desk mistake
 * reversal only). Check-Out (BE-13H) will close the visit; it is NOT
 * part of this migration.
 */
export const migration0139CreateVisitCheckIns: Migration = {
  id: '0139_create_visit_check_ins',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE visit_check_ins (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        visitor_id             UUID NOT NULL REFERENCES visitors (id),
        expected_visitor_id    UUID REFERENCES expected_visitors (id),
        walk_in_visit_id       UUID REFERENCES walk_in_visits (id),
        checked_in_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checked_in_by_user_id  UUID NOT NULL REFERENCES users (id),
        entry_notes            TEXT,
        status                 TEXT NOT NULL DEFAULT 'CHECKED_IN',
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT visit_check_ins_status_check
          CHECK (status IN ('CHECKED_IN', 'CANCELLED')),
        CONSTRAINT visit_check_ins_visit_reference_check
          CHECK (
            (expected_visitor_id IS NOT NULL)::int
            + (walk_in_visit_id IS NOT NULL)::int = 1
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX visit_check_ins_active_expected_unique
        ON visit_check_ins (expected_visitor_id)
        WHERE expected_visitor_id IS NOT NULL AND status = 'CHECKED_IN';
      CREATE UNIQUE INDEX visit_check_ins_active_walk_in_unique
        ON visit_check_ins (walk_in_visit_id)
        WHERE walk_in_visit_id IS NOT NULL AND status = 'CHECKED_IN';
      CREATE INDEX visit_check_ins_building_idx
        ON visit_check_ins (building_id, status, checked_in_at);
      CREATE INDEX visit_check_ins_client_idx
        ON visit_check_ins (client_id, status);
      CREATE INDEX visit_check_ins_visitor_idx
        ON visit_check_ins (visitor_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS visit_check_ins');
  },
};
