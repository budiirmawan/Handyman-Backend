import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03D2 — Workforce Skill Assignment.
 *
 * The link table that connects the two existing sides:
 *
 *   Workforce Profile (BE-03C) → Workforce Skill Assignment → Skill (BE-03D1)
 *
 * It records that a person *holds* a competency, at a proficiency level, over
 * an optional validity window. It is an assignment only: it never confers a
 * Position, Role, Permission, Team, Shift, or Building Assignment. Effective
 * skill resolution (deciding which assignments are currently in force) is
 * BE-03D3 and is deliberately not implemented here.
 *
 * Cross-table rules the FKs cannot express are enforced in the service layer:
 * the Skill must be ACTIVE, and the Workforce Profile and Skill must belong to
 * the same Client (profile → organization → client vs. skill → client).
 *
 * Duplicate protection is a *partial* unique index rather than a plain UNIQUE
 * constraint: a person may hold the same Skill only once at a time, but the
 * history of previously deactivated assignments is preserved rather than
 * blocking re-assignment later.
 */
export const migration0026CreateWorkforceSkillAssignments: Migration = {
  id: '0026_create_workforce_skill_assignments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE workforce_skill_assignments (
        id                   UUID PRIMARY KEY,
        workforce_profile_id UUID NOT NULL,
        skill_id             UUID NOT NULL,
        proficiency_level    TEXT NOT NULL DEFAULT 'BASIC',
        valid_from           TIMESTAMPTZ,
        valid_until          TIMESTAMPTZ,
        status               TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT workforce_skill_assignments_workforce_profile_id_fkey
          FOREIGN KEY (workforce_profile_id) REFERENCES workforce_profiles (id),
        CONSTRAINT workforce_skill_assignments_skill_id_fkey
          FOREIGN KEY (skill_id) REFERENCES skills (id),
        CONSTRAINT workforce_skill_assignments_proficiency_level_check
          CHECK (proficiency_level IN ('BASIC', 'INTERMEDIATE', 'ADVANCED', 'EXPERT')),
        CONSTRAINT workforce_skill_assignments_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT workforce_skill_assignments_validity_check
          CHECK (
            valid_from IS NULL
            OR valid_until IS NULL
            OR valid_until >= valid_from
          )
      )
    `);

    // One ACTIVE assignment per (profile, skill); INACTIVE history is retained.
    await client.query(`
      CREATE UNIQUE INDEX workforce_skill_assignments_active_unique
        ON workforce_skill_assignments (workforce_profile_id, skill_id)
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX workforce_skill_assignments_workforce_profile_id_idx
        ON workforce_skill_assignments (workforce_profile_id)
    `);

    await client.query(`
      CREATE INDEX workforce_skill_assignments_skill_id_idx
        ON workforce_skill_assignments (skill_id)
    `);

    await client.query(`
      CREATE INDEX workforce_skill_assignments_status_idx
        ON workforce_skill_assignments (status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS workforce_skill_assignments');
  },
};
