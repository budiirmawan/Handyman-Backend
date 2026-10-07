import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-21I — Corrective Action Due Date.
 *
 * The deadline is an ATTRIBUTE OF THE CORRECTIVE ACTION, so it lives as a
 * column on `corrective_actions` rather than in a table of its own. A
 * corrective action has exactly one current deadline; modelling that as a
 * separate row would invent a 1:1 side table and force a JOIN to answer
 * "when is this due?".
 *
 * WHY THERE IS NO SCHEDULER, SLA, OR JOB TABLE
 * --------------------------------------------
 * OVERDUE is DERIVED, never stored: it is a pure function of `due_date`, the
 * action's current status, `completed_at`, and the clock at read time. That
 * choice is the whole reason no background machinery is needed here.
 *
 * A stored `is_overdue` flag (or an SLA/scheduler table driving one) would be
 * wrong in three separate ways:
 *   1. It is false the instant it is written — a row becomes overdue by the
 *      passage of time, with no event to react to. Keeping a stored flag
 *      truthful requires a sweeper job, which is exactly what this PART is
 *      forbidden to build and would be redundant regardless.
 *   2. It duplicates state already implied by two columns, so the flag and
 *      the timestamps can disagree.
 *   3. It answers the question only at write time, whereas callers ask it at
 *      read time.
 * Deriving costs a comparison per row and cannot drift.
 *
 * The partial index below is what keeps the derived query cheap — deadline
 * scans touch only rows that actually have a deadline. It is an index, not a
 * queue: nothing consumes it on a timer.
 *
 * AUDIT, NOT A HISTORY TABLE
 * --------------------------
 * `due_date_set_at` / `due_date_set_by_user_id` record who last set the
 * deadline and when, mirroring how BE-21G already keeps transition metadata
 * ON the row. The full change history (set → moved → cleared) is the shared
 * append-only BE-07 `operational_events` log, the same primitive every other
 * BE-21 PART uses. No bespoke due-date history table.
 *
 * STILL DELIBERATELY ABSENT: no `target_date` (a second competing deadline),
 * no reminder/notification columns, and no escalation policy. Verification
 * (BE-21J) and closure (BE-21K) remain out of scope; COMPLETED is still
 * terminal here.
 */
export const migration0221AddCorrectiveActionDueDate: Migration = {
  id: '0221_add_corrective_action_due_date',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE corrective_actions
        ADD COLUMN due_date               TIMESTAMPTZ,
        ADD COLUMN due_date_set_at        TIMESTAMPTZ,
        ADD COLUMN due_date_set_by_user_id UUID REFERENCES users (id)
    `);

    // The deadline and the record of who set it stand or fall together, so a
    // due date can never appear without provenance.
    await client.query(`
      ALTER TABLE corrective_actions
        ADD CONSTRAINT corrective_actions_due_date_check
        CHECK (
          (due_date IS NULL
            AND due_date_set_at IS NULL
            AND due_date_set_by_user_id IS NULL)
          OR
          (due_date IS NOT NULL
            AND due_date_set_at IS NOT NULL
            AND due_date_set_by_user_id IS NOT NULL)
        )
    `);

    // Partial: only rows with a deadline are ever scanned for one.
    await client.query(`
      CREATE INDEX corrective_actions_due_date_idx
        ON corrective_actions (due_date)
        WHERE due_date IS NOT NULL
    `);

    // Supports "what is open and past due" — the derived OVERDUE question —
    // without materializing the answer anywhere.
    await client.query(`
      CREATE INDEX corrective_actions_open_due_date_idx
        ON corrective_actions (status, due_date)
        WHERE due_date IS NOT NULL
          AND status IN ('PROPOSED', 'APPROVED', 'IN_PROGRESS')
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS corrective_actions_open_due_date_idx;
      DROP INDEX IF EXISTS corrective_actions_due_date_idx
    `);
    await client.query(`
      ALTER TABLE corrective_actions
        DROP CONSTRAINT IF EXISTS corrective_actions_due_date_check
    `);
    await client.query(`
      ALTER TABLE corrective_actions
        DROP COLUMN IF EXISTS due_date_set_by_user_id,
        DROP COLUMN IF EXISTS due_date_set_at,
        DROP COLUMN IF EXISTS due_date
    `);
  },
};
