import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03D1 — Skill Catalog foundation.
 *
 * A Skill is a Client-scoped competency master record: the catalog of
 * capabilities a Client recognises (e.g. HVAC troubleshooting, fire-safety
 * response, high-voltage work). It is a *master/reference* entity only.
 *
 * It is NOT an assignment: attaching a Skill to a Workforce Profile — with a
 * proficiency level, evidence, or expiry — is BE-03D2 and deliberately lives in
 * a separate table. Nothing here references workforce_profiles.
 *
 * Scoping follows the BE-02D Property precedent: every Skill belongs to exactly
 * one Client, and `code` is unique per Client (`client_id + code`) so two
 * Clients may independently define the same code. Inactive Skills are retained
 * for history rather than hard-deleted.
 */
export const migration0025CreateSkills: Migration = {
  id: '0025_create_skills',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE skills (
        id          UUID PRIMARY KEY,
        client_id   UUID NOT NULL,
        code        TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        category    TEXT NOT NULL DEFAULT 'TECHNICAL',
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT skills_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT skills_client_code_unique
          UNIQUE (client_id, code),
        CONSTRAINT skills_category_check
          CHECK (category IN ('TECHNICAL', 'OPERATIONAL', 'SAFETY', 'SPECIALIST')),
        CONSTRAINT skills_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX skills_client_id_idx ON skills (client_id)
    `);

    await client.query(`
      CREATE INDEX skills_status_idx ON skills (status)
    `);

    await client.query(`
      CREATE INDEX skills_category_idx ON skills (category)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS skills');
  },
};
