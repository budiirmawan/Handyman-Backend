import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03E — Workforce Shift Assignment.
 *
 * Connects an existing Workforce Profile (BE-03C) to an existing Shift:
 *
 *   Workforce Profile → Workforce Shift Assignment → Shift
 *
 * It records that a person is rostered onto a working window over an optional
 * effective period. Roster generation and automatic scheduling are explicitly
 * out of scope — assignments are always created deliberately.
 *
 * Cross-table rules the FKs cannot express live in the service layer: the Shift
 * must be ACTIVE and the Workforce Profile and Shift must resolve to the same
 * Client (profile → organization → client vs. shift.client_id).
 *
 * Duplicate protection mirrors the BE-03D2 idiom — a *partial* unique index
 * rather than a plain UNIQUE — so a person holds a given Shift at most once at
 * a time while previously deactivated rostering history is preserved.
 */
export const migration0028CreateWorkforceShiftAssignments: Migration = {
  id: '0028_create_workforce_shift_assignments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE workforce_shift_assignments (
        id                   UUID PRIMARY KEY,
        workforce_profile_id UUID NOT NULL,
        shift_id             UUID NOT NULL,
        effective_from       TIMESTAMPTZ,
        effective_until      TIMESTAMPTZ,
        status               TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT workforce_shift_assignments_workforce_profile_id_fkey
          FOREIGN KEY (workforce_profile_id) REFERENCES workforce_profiles (id),
        CONSTRAINT workforce_shift_assignments_shift_id_fkey
          FOREIGN KEY (shift_id) REFERENCES shifts (id),
        CONSTRAINT workforce_shift_assignments_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT workforce_shift_assignments_effective_range_check
          CHECK (
            effective_from IS NULL
            OR effective_until IS NULL
            OR effective_until >= effective_from
          )
      )
    `);

    // One ACTIVE assignment per (profile, shift); INACTIVE history is retained.
    await client.query(`
      CREATE UNIQUE INDEX workforce_shift_assignments_active_unique
        ON workforce_shift_assignments (workforce_profile_id, shift_id)
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX workforce_shift_assignments_workforce_profile_id_idx
        ON workforce_shift_assignments (workforce_profile_id)
    `);
    await client.query(`
      CREATE INDEX workforce_shift_assignments_shift_id_idx
        ON workforce_shift_assignments (shift_id)
    `);
    await client.query(`
      CREATE INDEX workforce_shift_assignments_status_idx
        ON workforce_shift_assignments (status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS workforce_shift_assignments');
  },
};
