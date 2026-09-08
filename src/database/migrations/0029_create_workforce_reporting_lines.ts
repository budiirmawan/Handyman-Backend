import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03F — Workforce Reporting Line / Supervisor.
 *
 * Makes the reporting relationship authoritative, persisted data:
 *
 *   Workforce Profile → reports to → Supervisor Workforce Profile
 *
 * A Supervisor is another valid Workforce Profile. The relationship is never
 * derived from Role, Position, Team, or a Department's name — those may
 * correlate with it, but only this table decides who reports to whom.
 *
 * Reporting lines change over time, so history is preserved rather than
 * overwritten: a superseded line is flipped to INACTIVE and kept. There is no
 * hard delete anywhere in this slice.
 *
 * Constraints encoded here:
 *   - self-supervision is impossible at the storage layer,
 *   - the effective window must not end before it starts,
 *   - a *partial* unique index gives each Workforce Profile at most one ACTIVE
 *     supervisor at a time while leaving deactivated history untouched.
 *
 * Rules the schema cannot express — cross-Client rejection, inactive profiles,
 * and circular relationships such as A → B plus B → A — live in the service
 * layer.
 */
export const migration0029CreateWorkforceReportingLines: Migration = {
  id: '0029_create_workforce_reporting_lines',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE workforce_reporting_lines (
        id                              UUID PRIMARY KEY,
        workforce_profile_id            UUID NOT NULL,
        supervisor_workforce_profile_id UUID NOT NULL,
        effective_from                  TIMESTAMPTZ,
        effective_until                 TIMESTAMPTZ,
        status                          TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT workforce_reporting_lines_workforce_profile_id_fkey
          FOREIGN KEY (workforce_profile_id) REFERENCES workforce_profiles (id),
        CONSTRAINT workforce_reporting_lines_supervisor_profile_id_fkey
          FOREIGN KEY (supervisor_workforce_profile_id)
          REFERENCES workforce_profiles (id),
        CONSTRAINT workforce_reporting_lines_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT workforce_reporting_lines_no_self_supervision_check
          CHECK (workforce_profile_id <> supervisor_workforce_profile_id),
        CONSTRAINT workforce_reporting_lines_effective_range_check
          CHECK (
            effective_from IS NULL
            OR effective_until IS NULL
            OR effective_until >= effective_from
          )
      )
    `);

    // At most one ACTIVE supervisor per Workforce Profile; INACTIVE history is
    // retained so a reporting-line change is auditable.
    await client.query(`
      CREATE UNIQUE INDEX workforce_reporting_lines_active_unique
        ON workforce_reporting_lines (workforce_profile_id)
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX workforce_reporting_lines_workforce_profile_id_idx
        ON workforce_reporting_lines (workforce_profile_id)
    `);
    await client.query(`
      CREATE INDEX workforce_reporting_lines_supervisor_profile_id_idx
        ON workforce_reporting_lines (supervisor_workforce_profile_id)
    `);
    await client.query(`
      CREATE INDEX workforce_reporting_lines_status_idx
        ON workforce_reporting_lines (status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS workforce_reporting_lines');
  },
};
