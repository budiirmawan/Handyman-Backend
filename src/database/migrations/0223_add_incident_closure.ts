import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-21K — Incident Closure.
 *
 * Closure is the END of the BE-21A Incident lifecycle: the remedy has been
 * carried out and independently verified, so the Incident is settled and
 * sealed. This migration adds ONE new status to the shared foundation table
 * and the metadata that records who sealed it.
 *
 * NO NEW TABLE. Closure is a state of the Incident, not an entity of its own.
 * A `closures` table would create a second place to ask "is this closed" and
 * let the two disagree; the row itself is the answer.
 *
 * WHY THE STATE CHECK IS REWRITTEN
 * --------------------------------
 * `incidents_state_check` (0214) enumerated exactly two states and demanded
 * that a REPORTED row carry no cancellation metadata. It is rewritten here as
 * a three-branch constraint so CLOSED is reachable and each terminal state
 * carries exactly its own metadata:
 *
 *   REPORTED  — no cancellation metadata, no closure metadata.
 *   CANCELLED — cancellation metadata, no closure metadata.
 *   CLOSED    — closure metadata, no cancellation metadata.
 *
 * The last branch matters: CLOSED and CANCELLED are mutually exclusive
 * outcomes. An Incident that was withdrawn was never resolved, and one that
 * was resolved was never withdrawn. Allowing a row to carry both would make
 * the record of what happened ambiguous.
 *
 * CLOSED IS TERMINAL
 * ------------------
 * Nothing in this migration permits a transition OUT of CLOSED. Every
 * existing BE-21 child gate is written as `status !== 'REPORTED'`, so adding
 * CLOSED automatically freezes corrective actions, immediate actions,
 * responsibilities, due dates, and verifications against a closed Incident —
 * no per-module change is needed, and none is made. That is precisely why
 * `REPORTED` was the positive condition rather than `!== 'CANCELLED'`.
 *
 * HISTORY IS PRESERVED
 * --------------------
 * Closure adds a status and metadata; it deletes and rewrites nothing. The
 * Incident's corrective actions, their verifications in the shared `reviews`
 * table, and the BE-07 `operational_events` log all survive closure intact
 * and remain readable afterwards.
 *
 * `closure_notes` is the human account of why the Incident could be closed.
 * There is deliberately no `closure_reason` ENUM: unlike a rejection, closure
 * has exactly one meaning — the work is done and verified — so a controlled
 * vocabulary would add ceremony without information.
 */
export const migration0223AddIncidentClosure: Migration = {
  id: '0223_add_incident_closure',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE incidents
        ADD COLUMN closed_at         TIMESTAMPTZ,
        ADD COLUMN closed_by_user_id UUID REFERENCES users (id),
        ADD COLUMN closure_notes     TEXT
    `);

    await client.query(`
      ALTER TABLE incidents DROP CONSTRAINT incidents_status_check;
      ALTER TABLE incidents ADD CONSTRAINT incidents_status_check
        CHECK (status IN ('REPORTED', 'CANCELLED', 'CLOSED'));
    `);

    // Each state carries exactly its own metadata, and CLOSED/CANCELLED are
    // mutually exclusive.
    await client.query(`
      ALTER TABLE incidents DROP CONSTRAINT incidents_state_check;
      ALTER TABLE incidents ADD CONSTRAINT incidents_state_check
        CHECK (
          (status = 'REPORTED'
            AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
            AND closed_at IS NULL AND closed_by_user_id IS NULL)
          OR
          (status = 'CANCELLED'
            AND cancelled_at IS NOT NULL
            AND cancelled_by_user_id IS NOT NULL
            AND closed_at IS NULL AND closed_by_user_id IS NULL)
          OR
          (status = 'CLOSED'
            AND closed_at IS NOT NULL
            AND closed_by_user_id IS NOT NULL
            AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
        );
    `);

    await client.query(`
      CREATE INDEX incidents_closed_idx
        ON incidents (building_id, closed_at DESC)
        WHERE status = 'CLOSED'
    `);
  },

  /**
   * A true inverse. Closed Incidents are returned to REPORTED and their
   * closure metadata removed first, since neither can survive under the
   * restored two-state constraint — the destructive-restore convention
   * already used by 0095, 0211, 0213, and 0222.
   */
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP INDEX IF EXISTS incidents_closed_idx');

    await client.query(`
      UPDATE incidents
      SET status = 'REPORTED',
          closed_at = NULL,
          closed_by_user_id = NULL,
          closure_notes = NULL
      WHERE status = 'CLOSED'
    `);

    await client.query(`
      ALTER TABLE incidents DROP CONSTRAINT incidents_state_check;
      ALTER TABLE incidents ADD CONSTRAINT incidents_state_check
        CHECK (
          (status = 'REPORTED'
            AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
          OR
          (status = 'CANCELLED'
            AND cancelled_at IS NOT NULL
            AND cancelled_by_user_id IS NOT NULL)
        );
    `);

    await client.query(`
      ALTER TABLE incidents DROP CONSTRAINT incidents_status_check;
      ALTER TABLE incidents ADD CONSTRAINT incidents_status_check
        CHECK (status IN ('REPORTED', 'CANCELLED'));
    `);

    await client.query(`
      ALTER TABLE incidents
        DROP COLUMN IF EXISTS closure_notes,
        DROP COLUMN IF EXISTS closed_by_user_id,
        DROP COLUMN IF EXISTS closed_at
    `);
  },
};
