import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03G — Workforce Building Assignment.
 *
 * Records where a workforce member is *operationally assigned*:
 *
 *   Workforce Profile → Workforce Building Assignment → Building
 *
 * This is deliberately NOT the same thing as the BE-02F table
 * `user_building_assignments`, and the two must never be conflated:
 *
 *   user_building_assignments      — where a system User may *access* data.
 *   workforce_building_assignments — where a workforce member *works*.
 *
 * A User may have access to a Building they never work at, and a workforce
 * member may work at a Building whose data their User login cannot read. Each
 * table is written only by its own slice; neither is derived from the other,
 * nor from Role, Position, Team, Shift, or Supervisor.
 *
 * One Workforce Profile may hold several Buildings at once, so the assignment
 * lives in its own row rather than as a single `building_id` column on
 * `workforce_profiles`.
 *
 * Duplicate protection follows the BE-03D2/BE-03E idiom — a *partial* unique
 * index rather than a plain UNIQUE — so a person holds a given Building at most
 * once at a time while deactivated history is preserved.
 *
 * Cross-table rules the FKs cannot express — the Building must be ACTIVE, and
 * the Workforce Profile and Building must resolve to the same Client (profile →
 * organization → client vs. building → property → client) — live in the service
 * layer.
 */
export const migration0030CreateWorkforceBuildingAssignments: Migration = {
  id: '0030_create_workforce_building_assignments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE workforce_building_assignments (
        id                   UUID PRIMARY KEY,
        workforce_profile_id UUID NOT NULL,
        building_id          UUID NOT NULL,
        effective_from       TIMESTAMPTZ,
        effective_until      TIMESTAMPTZ,
        status               TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT workforce_building_assignments_workforce_profile_id_fkey
          FOREIGN KEY (workforce_profile_id) REFERENCES workforce_profiles (id),
        CONSTRAINT workforce_building_assignments_building_id_fkey
          FOREIGN KEY (building_id) REFERENCES buildings (id),
        CONSTRAINT workforce_building_assignments_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT workforce_building_assignments_effective_range_check
          CHECK (
            effective_from IS NULL
            OR effective_until IS NULL
            OR effective_until >= effective_from
          )
      )
    `);

    // One ACTIVE assignment per (profile, building); INACTIVE history is
    // retained, and a profile may still hold several different Buildings.
    await client.query(`
      CREATE UNIQUE INDEX workforce_building_assignments_active_unique
        ON workforce_building_assignments (workforce_profile_id, building_id)
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX workforce_building_assignments_workforce_profile_id_idx
        ON workforce_building_assignments (workforce_profile_id)
    `);
    await client.query(`
      CREATE INDEX workforce_building_assignments_building_id_idx
        ON workforce_building_assignments (building_id)
    `);
    await client.query(`
      CREATE INDEX workforce_building_assignments_status_idx
        ON workforce_building_assignments (status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS workforce_building_assignments');
  },
};
