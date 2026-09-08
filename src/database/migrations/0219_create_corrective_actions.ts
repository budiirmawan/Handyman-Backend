import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-21G — Corrective Action.
 *
 * A Corrective Action is the durable fix that stops an Incident recurring
 * ("replace the failed pump seal", "revise the wet-floor procedure"). Like
 * BE-21E it belongs to exactly one BE-21A Incident of ANY type and is a CHILD
 * COLLECTION — one Incident often needs several corrective actions, so
 * `incident_id` is deliberately NOT unique and each action has its own id.
 *
 * HOW THIS DIFFERS FROM BE-21E IMMEDIATE ACTION
 * ---------------------------------------------
 * They are NOT the same record at different stages, and merging them would be
 * a modelling error. An Immediate Action is containment already taken — it is
 * recorded after the fact and its `taken_at` is in the past. A Corrective
 * Action is remedial work PROPOSED for the future: it is approved or
 * rejected, then executed. That is why this table has an approval step and no
 * `taken_at`, while BE-21E has `taken_at` and no approval.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 * -------------------------------
 * No `responsible_user_id` and no `due_date` / `target_date` column. Those
 * are BE-21H (Responsible Person) and BE-21I (Due Date), which are NOT in
 * scope for this PART. Adding either "just as a convenience field" would
 * pre-empt those PARTs and leave two competing notions of ownership and
 * deadline to reconcile later. `approved_by_user_id` and
 * `completed_by_user_id` are NOT assignments: they record who actually
 * performed a transition, exactly as BE-21E does.
 *
 * Client / Building context, severity, priority, and the Incident lifecycle
 * stay on `incidents` and are resolved through the FK, never copied.
 *
 * Verification (BE-21J) and closure (BE-21K) are also absent: COMPLETED is
 * terminal HERE, and a later PART may extend the lifecycle beyond it.
 *
 * HISTORY
 * -------
 * "Preserve action history" is satisfied by the shared append-only BE-07
 * `operational_events` log (entity_type = 'CORRECTIVE_ACTION'), the same
 * primitive BE-21E uses — not a bespoke history table. Transition metadata
 * (`approved_at`, `approved_by_user_id`, `completed_at`,
 * `completed_by_user_id`, `status_changed_at`) is additionally preserved ON
 * the row so no transition is a destructive overwrite.
 *
 * The CHECK constraints make those invariants structural rather than merely
 * enforced in code: a COMPLETED row must carry completion metadata, a
 * REJECTED row must carry its reason, and a row that was never approved must
 * not claim approval metadata.
 */
export const migration0219CreateCorrectiveActions: Migration = {
  id: '0219_create_corrective_actions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE corrective_actions (
        id                   UUID PRIMARY KEY,
        incident_id          UUID NOT NULL REFERENCES incidents (id),
        action_type          TEXT NOT NULL,
        description          TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'PROPOSED',
        proposed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at          TIMESTAMPTZ,
        approved_by_user_id  UUID REFERENCES users (id),
        rejected_at          TIMESTAMPTZ,
        rejected_by_user_id  UUID REFERENCES users (id),
        rejection_reason     TEXT,
        started_at           TIMESTAMPTZ,
        completed_at         TIMESTAMPTZ,
        completed_by_user_id UUID REFERENCES users (id),
        completion_notes     TEXT,
        cancelled_at         TIMESTAMPTZ,
        cancelled_by_user_id UUID REFERENCES users (id),
        status_changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notes                TEXT,
        created_by_user_id   UUID NOT NULL REFERENCES users (id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT corrective_actions_type_check
          CHECK (action_type IN (
            'REPAIR', 'REPLACEMENT', 'PROCESS_CHANGE', 'TRAINING',
            'MAINTENANCE_PLAN_UPDATE', 'DESIGN_CHANGE', 'POLICY_UPDATE',
            'INSPECTION_REGIME', 'VENDOR_ACTION', 'OTHER'
          )),
        CONSTRAINT corrective_actions_status_check
          CHECK (status IN (
            'PROPOSED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED',
            'REJECTED', 'CANCELLED'
          )),
        -- Approval metadata may exist only once the action has actually been
        -- approved; every state reachable only THROUGH approval keeps it.
        CONSTRAINT corrective_actions_approval_check
          CHECK (
            (status IN ('APPROVED', 'IN_PROGRESS', 'COMPLETED')
              AND approved_at IS NOT NULL
              AND approved_by_user_id IS NOT NULL)
            OR
            (status IN ('PROPOSED', 'REJECTED')
              AND approved_at IS NULL
              AND approved_by_user_id IS NULL)
            OR
            -- CANCELLED is reachable both before and after approval, so it
            -- keeps whatever approval metadata it legitimately had.
            status = 'CANCELLED'
          ),
        CONSTRAINT corrective_actions_rejection_check
          CHECK (
            (status = 'REJECTED'
              AND rejected_at IS NOT NULL
              AND rejected_by_user_id IS NOT NULL
              AND rejection_reason IS NOT NULL)
            OR
            (status <> 'REJECTED'
              AND rejected_at IS NULL
              AND rejected_by_user_id IS NULL
              AND rejection_reason IS NULL)
          ),
        CONSTRAINT corrective_actions_completion_check
          CHECK (
            (status = 'COMPLETED'
              AND completed_at IS NOT NULL
              AND completed_by_user_id IS NOT NULL)
            OR
            (status <> 'COMPLETED'
              AND completed_at IS NULL
              AND completed_by_user_id IS NULL)
          ),
        CONSTRAINT corrective_actions_cancellation_check
          CHECK (
            (status = 'CANCELLED'
              AND cancelled_at IS NOT NULL
              AND cancelled_by_user_id IS NOT NULL)
            OR
            (status <> 'CANCELLED'
              AND cancelled_at IS NULL
              AND cancelled_by_user_id IS NULL)
          )
      )
    `);

    await client.query(`
      CREATE INDEX corrective_actions_incident_idx
        ON corrective_actions (incident_id, proposed_at DESC);
      CREATE INDEX corrective_actions_status_idx
        ON corrective_actions (status, proposed_at DESC);
      CREATE INDEX corrective_actions_type_idx
        ON corrective_actions (action_type, status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS corrective_actions');
  },
};
