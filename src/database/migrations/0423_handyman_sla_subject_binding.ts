import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-16 PART 01 — Handyman subject/binding extension of the shared SLA
 * engine (governance `docs/handyman/CR-HM-16_START_GOVERNANCE.md` §4/§7
 * seam 1, §9 PART 01 row: "subject-type extension, snapshot/clock/breach
 * reuse statement").
 *
 * ADDITIVE ONLY. Clocks (`sla_clocks`), pause intervals
 * (`sla_clock_pause_intervals`), breach (`sla_clocks.breached_at` + the
 * first-write-idempotent `markBreached` writer) and escalation
 * (`sla_escalation_policies/levels/actions`) are REUSED UNCHANGED — no second
 * engine, scheduler, clock state machine or breach writer.
 *
 * What this widens — the BINDING surface only:
 *   1. `sla_definitions.operational_type` admits the closed Handyman subject
 *      vocabulary (see `sla-definitions/handyman-sla-subjects.ts`).
 *   2. `applied_slas` gains a generic polymorphic subject binding
 *      (`subject_id` + subject applicability snapshots) beside the existing
 *      Work Order binding. The binding CHECK enforces exactly one binding
 *      kind per row, mirroring `UNIQUE(work_order_id)` for subjects.
 *   3. `sla_clock_pause_intervals.pause_source` admits `SUBJECT_ON_HOLD` so
 *      Handyman subject holds reuse the same pause authority.
 *
 * Firewalls: Handyman rows never set `work_order_id` (no FM WO /
 * work-order-sla-register / SaaS coupling); `subject_id` carries NO FK — the
 * shared engine stays generic and Handyman lifecycles remain the authority
 * for their own subjects' existence. Escalation stays Work-Order-scoped in
 * this PART (Handyman escalation binding ships with the PART 02
 * notification-intent contract).
 */
export const migration0423HandymanSlaSubjectBinding: Migration = {
  id: '0423_handyman_sla_subject_binding',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE sla_definitions
        DROP CONSTRAINT sla_definitions_operational_type_check,
        ADD CONSTRAINT sla_definitions_operational_type_check
          CHECK (operational_type IN (
            'WORK_ORDER',
            'HANDYMAN_SERVICE_REQUEST',
            'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
            'HANDYMAN_EXECUTION_SCOPE',
            'HANDYMAN_DEFECT_RECORD',
            'HANDYMAN_SERVICE_WARRANTY_CLAIM'
          ));

      ALTER TABLE applied_slas
        DROP CONSTRAINT applied_slas_operational_type_check;
      ALTER TABLE applied_slas
        ALTER COLUMN work_order_id DROP NOT NULL,
        ALTER COLUMN work_order_work_type DROP NOT NULL,
        ALTER COLUMN work_order_priority DROP NOT NULL,
        ADD COLUMN subject_id UUID,
        ADD COLUMN subject_work_type TEXT,
        ADD COLUMN subject_priority TEXT;
      ALTER TABLE applied_slas
        ADD CONSTRAINT applied_slas_operational_type_check
          CHECK (operational_type IN (
            'WORK_ORDER',
            'HANDYMAN_SERVICE_REQUEST',
            'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
            'HANDYMAN_EXECUTION_SCOPE',
            'HANDYMAN_DEFECT_RECORD',
            'HANDYMAN_SERVICE_WARRANTY_CLAIM'
          )),
        ADD CONSTRAINT applied_slas_binding_check CHECK (
          (operational_type = 'WORK_ORDER' AND work_order_id IS NOT NULL AND subject_id IS NULL)
          OR
          (operational_type <> 'WORK_ORDER' AND subject_id IS NOT NULL AND work_order_id IS NULL)
        );
      CREATE UNIQUE INDEX applied_slas_subject_unique_idx
        ON applied_slas (subject_id) WHERE subject_id IS NOT NULL;

      ALTER TABLE sla_clock_pause_intervals
        DROP CONSTRAINT sla_pause_source_check,
        ADD CONSTRAINT sla_pause_source_check
          CHECK (pause_source IN ('WORK_ORDER_ON_HOLD','SUBJECT_ON_HOLD'));
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE sla_clock_pause_intervals
        DROP CONSTRAINT sla_pause_source_check,
        ADD CONSTRAINT sla_pause_source_check CHECK (pause_source = 'WORK_ORDER_ON_HOLD');
      DROP INDEX IF EXISTS applied_slas_subject_unique_idx;
      ALTER TABLE applied_slas
        DROP CONSTRAINT IF EXISTS applied_slas_binding_check,
        DROP COLUMN IF EXISTS subject_priority,
        DROP COLUMN IF EXISTS subject_work_type,
        DROP COLUMN IF EXISTS subject_id,
        ALTER COLUMN work_order_priority SET NOT NULL,
        ALTER COLUMN work_order_work_type SET NOT NULL,
        ALTER COLUMN work_order_id SET NOT NULL;
      ALTER TABLE applied_slas
        DROP CONSTRAINT applied_slas_operational_type_check,
        ADD CONSTRAINT applied_slas_operational_type_check CHECK (operational_type = 'WORK_ORDER');
      ALTER TABLE sla_definitions
        DROP CONSTRAINT sla_definitions_operational_type_check,
        ADD CONSTRAINT sla_definitions_operational_type_check CHECK (operational_type = 'WORK_ORDER');
    `);
  },
};
