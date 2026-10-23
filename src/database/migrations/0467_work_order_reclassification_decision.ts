import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2E — Work Order classification finalization.
 *
 * Operations may now re-classify a Work Order while an assignment is still
 * ACTIVE (a job started as PLUMBING turns out to involve ELECTRICAL_MINOR, a
 * tenant adds scope, or triage simply picked the wrong trade). That decision is
 * only safe if the CURRENT assignment is revalidated against the NEW
 * requirement set inside the same transaction — and if the outcome is written
 * where every other competency decision already lives, so the ledger can still
 * explain the ACTIVE assignment without re-deriving history.
 *
 * The ledger therefore gains exactly one action value: `RECLASSIFIED`.
 *
 * Additive and backward compatible: no existing row changes meaning, and the
 * two pre-existing actions keep their exact semantics. The table stays
 * append-only — nothing is updated or deleted by this migration.
 */
export const migration0467WorkOrderReclassificationDecision: Migration = {
  id: '0467_work_order_reclassification_decision',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE work_order_assignment_competency_decisions
        DROP CONSTRAINT work_order_assignment_competency_decisions_action_check
    `);
    await client.query(`
      ALTER TABLE work_order_assignment_competency_decisions
        ADD CONSTRAINT work_order_assignment_competency_decisions_action_check
          CHECK (action IN ('ASSIGNED', 'REASSIGNED', 'RECLASSIFIED'))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // Rolling the vocabulary back would silently reinterpret real revalidation
    // evidence, so the rollback refuses while such rows exist instead of
    // deleting workforce/competency audit history.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM work_order_assignment_competency_decisions
           WHERE action = 'RECLASSIFIED'
        ) THEN
          RAISE EXCEPTION
            'cannot roll back 0467: RECLASSIFIED competency decisions exist';
        END IF;
      END $$;
    `);

    await client.query(`
      ALTER TABLE work_order_assignment_competency_decisions
        DROP CONSTRAINT work_order_assignment_competency_decisions_action_check
    `);
    await client.query(`
      ALTER TABLE work_order_assignment_competency_decisions
        ADD CONSTRAINT work_order_assignment_competency_decisions_action_check
          CHECK (action IN ('ASSIGNED', 'REASSIGNED'))
    `);
  },
};
