import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-13C — Expected Visitor.
 *
 * The front-desk "who is expected today" operational record. It
 * references the shared BE-13A visitor identity and — where the visit
 * was planned ahead — the BE-13B visitor invitation. An expected
 * visitor can also exist WITHOUT an invitation (e.g. a host phones the
 * front desk), so `visitor_invitation_id` is nullable.
 *
 * Identity boundary: references the `visitors` master; no visitor
 * personal data is duplicated. Invitation linkage is consistency-checked
 * (same Building, same Visitor) and at most ONE non-cancelled expected
 * visitor exists per invitation (partial unique index).
 *
 * Host boundary: same smallest-safe host reference as BE-13B
 * (optional User, optional Workforce profile, and/or free-form name;
 * at least one required).
 *
 * Lifecycle (minimal, backend-authoritative): EXPECTED → CANCELLED.
 * Check-In consumption of this record arrives in a later BE-13 PART.
 */
export const migration0135CreateExpectedVisitors: Migration = {
  id: '0135_create_expected_visitors',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE expected_visitors (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        visitor_id             UUID NOT NULL REFERENCES visitors (id),
        visitor_invitation_id  UUID REFERENCES visitor_invitations (id),
        host_user_id           UUID REFERENCES users (id),
        host_workforce_id      UUID REFERENCES workforce_profiles (id),
        host_name              TEXT,
        expected_arrival_at    TIMESTAMPTZ NOT NULL,
        expected_departure_at  TIMESTAMPTZ,
        purpose                TEXT NOT NULL,
        notes                  TEXT,
        status                 TEXT NOT NULL DEFAULT 'EXPECTED',
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT expected_visitors_status_check
          CHECK (status IN ('EXPECTED', 'CANCELLED')),
        CONSTRAINT expected_visitors_host_required
          CHECK (
            host_user_id IS NOT NULL
            OR host_workforce_id IS NOT NULL
            OR host_name IS NOT NULL
          ),
        CONSTRAINT expected_visitors_time_window
          CHECK (
            expected_departure_at IS NULL
            OR expected_departure_at > expected_arrival_at
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX expected_visitors_active_invitation_unique
        ON expected_visitors (visitor_invitation_id)
        WHERE visitor_invitation_id IS NOT NULL AND status = 'EXPECTED';
      CREATE INDEX expected_visitors_building_idx
        ON expected_visitors (building_id, status, expected_arrival_at);
      CREATE INDEX expected_visitors_client_idx
        ON expected_visitors (client_id, status);
      CREATE INDEX expected_visitors_visitor_idx
        ON expected_visitors (visitor_id, status);
      CREATE INDEX expected_visitors_host_user_idx
        ON expected_visitors (host_user_id);
      CREATE INDEX expected_visitors_host_workforce_idx
        ON expected_visitors (host_workforce_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS expected_visitors');
  },
};
