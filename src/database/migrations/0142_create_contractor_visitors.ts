import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-13J — Contractor Visitor.
 *
 * A contractor context specializes an existing BE-13 visit (Expected
 * Visitor or Walk-In) and reuses its shared Visitor identity, Building,
 * Check-In / Check-Out lifecycle, and Visitor Pass support. It is not a
 * separate visitor or visit engine.
 *
 * The row stores contractor-only metadata: company, work purpose,
 * responsible host/PIC, optional operational location, notes and a small
 * context lifecycle (REGISTERED → CANCELLED). Exactly one visit FK is
 * required and each visit can have at most one contractor context.
 */
export const migration0142CreateContractorVisitors: Migration = {
  id: '0142_create_contractor_visitors',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE contractor_visitors (
        id                              UUID PRIMARY KEY,
        client_id                       UUID NOT NULL REFERENCES clients (id),
        building_id                     UUID NOT NULL REFERENCES buildings (id),
        visitor_id                      UUID NOT NULL REFERENCES visitors (id),
        expected_visitor_id             UUID REFERENCES expected_visitors (id),
        walk_in_visit_id                UUID REFERENCES walk_in_visits (id),
        contractor_company              TEXT NOT NULL,
        contractor_purpose              TEXT NOT NULL,
        responsible_host_user_id        UUID REFERENCES users (id),
        responsible_host_workforce_id   UUID REFERENCES workforce_profiles (id),
        responsible_host_name           TEXT,
        functional_location_id          UUID REFERENCES functional_locations (id),
        work_location                   TEXT,
        notes                           TEXT,
        status                          TEXT NOT NULL DEFAULT 'REGISTERED',
        created_by_user_id              UUID NOT NULL REFERENCES users (id),
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT contractor_visitors_status_check
          CHECK (status IN ('REGISTERED', 'CANCELLED')),
        CONSTRAINT contractor_visitors_visit_reference_check
          CHECK (
            (expected_visitor_id IS NOT NULL)::int
            + (walk_in_visit_id IS NOT NULL)::int = 1
          ),
        CONSTRAINT contractor_visitors_host_required
          CHECK (
            responsible_host_user_id IS NOT NULL
            OR responsible_host_workforce_id IS NOT NULL
            OR responsible_host_name IS NOT NULL
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX contractor_visitors_expected_visit_unique
        ON contractor_visitors (expected_visitor_id)
        WHERE expected_visitor_id IS NOT NULL;
      CREATE UNIQUE INDEX contractor_visitors_walk_in_visit_unique
        ON contractor_visitors (walk_in_visit_id)
        WHERE walk_in_visit_id IS NOT NULL;
      CREATE INDEX contractor_visitors_building_idx
        ON contractor_visitors (building_id, status, created_at);
      CREATE INDEX contractor_visitors_client_idx
        ON contractor_visitors (client_id, status);
      CREATE INDEX contractor_visitors_visitor_idx
        ON contractor_visitors (visitor_id, status);
      CREATE INDEX contractor_visitors_host_user_idx
        ON contractor_visitors (responsible_host_user_id);
      CREATE INDEX contractor_visitors_host_workforce_idx
        ON contractor_visitors (responsible_host_workforce_id);
      CREATE INDEX contractor_visitors_location_idx
        ON contractor_visitors (functional_location_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS contractor_visitors');
  },
};
