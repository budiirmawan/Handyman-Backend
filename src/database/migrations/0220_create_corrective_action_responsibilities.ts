import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-21H — Responsible Person for a Corrective Action.
 *
 * Records WHO is accountable for carrying out a BE-21G Corrective Action.
 *
 * IT REFERENCES IDENTITY, IT NEVER COPIES IT
 * ------------------------------------------
 * The only person data stored here is `workforce_profile_id` — a foreign key
 * into BE-03C. There is deliberately NO name, email, phone, employee code,
 * position, department, or organization column. Those live on
 * `workforce_profiles` and are resolved through the FK on read.
 *
 * That restraint is the entire point of this PART. A copied name silently
 * rots the moment someone is renamed or transferred, and an incident record
 * that disagrees with the personnel record about who was responsible is worse
 * than no record at all.
 *
 * WHY WORKFORCE PROFILE, NOT USER
 * -------------------------------
 * This codebase separates the two (BE-03C states it explicitly):
 *
 *   User             → digital identity / authentication (BE-01)
 *   WorkforceProfile → operational personnel identity (BE-03C)
 *
 * Accountability for physical remedial work is an OPERATIONAL fact, so it
 * attaches to the workforce identity — which may exist with no User account
 * at all. BE-09 already assigns findings by `workforce_profile_id`, and this
 * follows that established convention rather than inventing a second notion
 * of "the responsible person". `assigned_by_user_id` is a different thing: it
 * is the authenticated actor who made the assignment, an auth fact.
 *
 * HISTORY, NOT OVERWRITE
 * ----------------------
 * Reassignment does NOT mutate a row. The current assignment is deactivated
 * and a new ACTIVE row is inserted, so the full chain of accountability
 * survives — matching BE-09's `finding_assignments`. The partial unique index
 * enforces at most ONE active responsible person per Corrective Action, which
 * is what makes "the responsible person" a well-defined question.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 * -------------------------------
 * No `due_date` / `target_date` column: that is BE-21I, the very next PART.
 * Adding one here "for convenience" would leave two competing deadlines to
 * reconcile. No verification (BE-21J) and no closure (BE-21K).
 */
export const migration0220CreateCorrectiveActionResponsibilities: Migration = {
  id: '0220_create_corrective_action_responsibilities',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE corrective_action_responsibilities (
        id                    UUID PRIMARY KEY,
        corrective_action_id  UUID NOT NULL REFERENCES corrective_actions (id),
        -- The ONLY person reference. Never a copied name or contact detail.
        workforce_profile_id  UUID NOT NULL REFERENCES workforce_profiles (id),
        responsibility_note   TEXT,
        status                TEXT NOT NULL DEFAULT 'ACTIVE',
        assigned_by_user_id   UUID NOT NULL REFERENCES users (id),
        assigned_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        released_at           TIMESTAMPTZ,
        released_by_user_id   UUID REFERENCES users (id),
        release_reason        TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT corrective_action_responsibilities_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        -- A superseded assignment must say when it ended and who ended it;
        -- an active one must claim neither.
        CONSTRAINT corrective_action_responsibilities_release_check
          CHECK (
            (status = 'INACTIVE'
              AND released_at IS NOT NULL
              AND released_by_user_id IS NOT NULL)
            OR
            (status = 'ACTIVE'
              AND released_at IS NULL
              AND released_by_user_id IS NULL
              AND release_reason IS NULL)
          )
      )
    `);

    await client.query(`
      -- At most ONE active responsible person per Corrective Action, enforced
      -- by the database rather than by application discipline: this is what
      -- makes "who is responsible?" a question with a single answer, even
      -- under concurrent assignment.
      CREATE UNIQUE INDEX corrective_action_active_responsibility_unique
        ON corrective_action_responsibilities (corrective_action_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX corrective_action_responsibilities_action_idx
        ON corrective_action_responsibilities
        (corrective_action_id, status, assigned_at DESC);
      CREATE INDEX corrective_action_responsibilities_workforce_idx
        ON corrective_action_responsibilities (workforce_profile_id, status);
      CREATE INDEX corrective_action_responsibilities_assigner_idx
        ON corrective_action_responsibilities (assigned_by_user_id, assigned_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS corrective_action_responsibilities',
    );
  },
};
