import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-13D — Walk-In / Guest Book.
 *
 * The front-desk guest-book entry for a visitor who arrives WITHOUT a
 * prior invitation. The entry always references the shared BE-13A
 * visitor identity master — a walk-in either reuses a matched existing
 * visitor or registers a new one through the BE-13A service; it NEVER
 * creates a second visitor master.
 *
 * Host boundary: host context is optional for a walk-in ("where
 * available") — an unannounced guest may have no resolvable host at
 * arrival time. When host references are supplied they are validated
 * exactly like BE-13B/C (User exists; Workforce ACTIVE + same Client).
 *
 * Scope: Building-scoped; `client_id` derived from Building → Property
 * → Client, never caller-supplied.
 *
 * Duplicate handling: at most ONE open (REGISTERED) guest-book entry
 * per (building, visitor) — partial unique index. CANCELLED entries
 * never block a new registration.
 *
 * Lifecycle (minimal, backend-authoritative): REGISTERED → CANCELLED.
 * Host Confirmation / Check-In / Pass / Check-Out consume this entry in
 * later BE-13 PARTs.
 */
export const migration0136CreateWalkInVisits: Migration = {
  id: '0136_create_walk_in_visits',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE walk_in_visits (
        id                  UUID PRIMARY KEY,
        client_id           UUID NOT NULL REFERENCES clients (id),
        building_id         UUID NOT NULL REFERENCES buildings (id),
        visitor_id          UUID NOT NULL REFERENCES visitors (id),
        host_user_id        UUID REFERENCES users (id),
        host_workforce_id   UUID REFERENCES workforce_profiles (id),
        host_name           TEXT,
        purpose             TEXT NOT NULL,
        arrived_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        front_desk_notes    TEXT,
        status              TEXT NOT NULL DEFAULT 'REGISTERED',
        created_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT walk_in_visits_status_check
          CHECK (status IN ('REGISTERED', 'CANCELLED'))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX walk_in_visits_active_visitor_unique
        ON walk_in_visits (building_id, visitor_id)
        WHERE status = 'REGISTERED';
      CREATE INDEX walk_in_visits_building_idx
        ON walk_in_visits (building_id, status, arrived_at);
      CREATE INDEX walk_in_visits_client_idx
        ON walk_in_visits (client_id, status);
      CREATE INDEX walk_in_visits_visitor_idx
        ON walk_in_visits (visitor_id, status);
      CREATE INDEX walk_in_visits_host_user_idx
        ON walk_in_visits (host_user_id);
      CREATE INDEX walk_in_visits_host_workforce_idx
        ON walk_in_visits (host_workforce_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS walk_in_visits');
  },
};
