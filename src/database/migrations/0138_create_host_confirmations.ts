import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-13F — Host / Tenant Confirmation.
 *
 * Backend-authoritative confirmation of a planned/registered visit by
 * its host. The "visit" is one of the existing BE-13 visit contexts —
 * an Expected Visitor (BE-13C) or a Walk-In / Guest Book entry
 * (BE-13D) — referenced by EXACTLY ONE of two FKs (CHECK enforced).
 * No new visit table and no visitor data duplication.
 *
 * Tenant boundary: the repository has no authoritative Tenant domain,
 * so the confirmation reuses the smallest safe host context already
 * established by BE-13B/C/D — host User, host Workforce profile,
 * and/or free-form host/tenant name (defaulted from the visit record,
 * overridable with validation). No Tenant Management domain is created.
 *
 * Lifecycle (backend-authoritative):
 *   PENDING → CONFIRMED | REJECTED   (terminal; single decision)
 * A REJECTED visit can never flip to CONFIRMED. One confirmation row
 * per visit (unique indexes on each visit FK).
 */
export const migration0138CreateHostConfirmations: Migration = {
  id: '0138_create_host_confirmations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE host_confirmations (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        expected_visitor_id   UUID REFERENCES expected_visitors (id),
        walk_in_visit_id      UUID REFERENCES walk_in_visits (id),
        host_user_id          UUID REFERENCES users (id),
        host_workforce_id     UUID REFERENCES workforce_profiles (id),
        host_name             TEXT,
        status                TEXT NOT NULL DEFAULT 'PENDING',
        confirmed_by_user_id  UUID REFERENCES users (id),
        confirmed_at          TIMESTAMPTZ,
        rejection_reason      TEXT,
        notes                 TEXT,
        created_by_user_id    UUID NOT NULL REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT host_confirmations_status_check
          CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED')),
        CONSTRAINT host_confirmations_visit_reference_check
          CHECK (
            (expected_visitor_id IS NOT NULL)::int
            + (walk_in_visit_id IS NOT NULL)::int = 1
          ),
        CONSTRAINT host_confirmations_host_required
          CHECK (
            host_user_id IS NOT NULL
            OR host_workforce_id IS NOT NULL
            OR host_name IS NOT NULL
          ),
        CONSTRAINT host_confirmations_decision_consistency
          CHECK (
            (status = 'PENDING' AND confirmed_by_user_id IS NULL
              AND confirmed_at IS NULL AND rejection_reason IS NULL)
            OR (status = 'CONFIRMED' AND confirmed_by_user_id IS NOT NULL
              AND confirmed_at IS NOT NULL AND rejection_reason IS NULL)
            OR (status = 'REJECTED' AND confirmed_by_user_id IS NOT NULL
              AND confirmed_at IS NOT NULL AND rejection_reason IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX host_confirmations_expected_visitor_unique
        ON host_confirmations (expected_visitor_id)
        WHERE expected_visitor_id IS NOT NULL;
      CREATE UNIQUE INDEX host_confirmations_walk_in_unique
        ON host_confirmations (walk_in_visit_id)
        WHERE walk_in_visit_id IS NOT NULL;
      CREATE INDEX host_confirmations_building_idx
        ON host_confirmations (building_id, status);
      CREATE INDEX host_confirmations_client_idx
        ON host_confirmations (client_id, status);
      CREATE INDEX host_confirmations_host_user_idx
        ON host_confirmations (host_user_id);
      CREATE INDEX host_confirmations_host_workforce_idx
        ON host_confirmations (host_workforce_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS host_confirmations');
  },
};
