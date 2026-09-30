import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-16 PART 02 — Handyman SLA escalation notification binding over the
 * existing SLA-02 escalation authority (governance
 * `docs/handyman/CR-HM-16_START_GOVERNANCE.md` §7 seam 2, §9 PART 02 row).
 *
 * ADDITIVE BINDING ONLY. The escalation lifecycle (specificity policy
 * selection, level offsets, snapshot-at-materialization, claim-before-send,
 * due-job draining, `recordNotification` intent) is REUSED UNCHANGED — no new
 * notification stack, scheduler or outbox. What widens:
 *
 *   1. `sla_escalation_policies.operational_type` admits the closed Handyman
 *      subject vocabulary (same registry the SLA engine accepted in 0423).
 *   2. `sla_escalation_actions` gains the same generic subject binding as
 *      `applied_slas` (0423): `work_order_id` nullable beside `subject_id`,
 *      plus a `subject_type` snapshot used as the notification source-entity
 *      type. The binding CHECK mirrors applied_slas: exactly one binding kind
 *      per row; Handyman rows never reference Work Orders (no FM coupling).
 *
 * Firewalls preserved: no SaaS coupling; notification intent for Handyman
 * subjects carries Handyman source-entity identity and NO Work Order
 * navigation target (the client falls back to the inbox). Provider-neutral:
 * no channel/provider column is added anywhere — delivery stays the reused
 * BE-26/NOTIFY-PROV-01 capability.
 */
export const migration0424HandymanSlaEscalationNotificationBinding: Migration = {
  id: '0424_handyman_sla_escalation_notification_binding',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE sla_escalation_policies
        DROP CONSTRAINT sla_escalation_policies_operational_type_check,
        ADD CONSTRAINT sla_escalation_policies_operational_type_check
          CHECK (operational_type IN (
            'WORK_ORDER',
            'HANDYMAN_SERVICE_REQUEST',
            'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
            'HANDYMAN_EXECUTION_SCOPE',
            'HANDYMAN_DEFECT_RECORD',
            'HANDYMAN_SERVICE_WARRANTY_CLAIM'
          ));

      ALTER TABLE sla_escalation_actions
        ALTER COLUMN work_order_id DROP NOT NULL,
        ADD COLUMN subject_id UUID,
        ADD COLUMN subject_type TEXT;
      UPDATE sla_escalation_actions SET subject_type='WORK_ORDER' WHERE work_order_id IS NOT NULL;
      ALTER TABLE sla_escalation_actions
        ALTER COLUMN subject_type SET NOT NULL,
        ADD CONSTRAINT sla_escalation_actions_binding_check CHECK (
          (work_order_id IS NOT NULL AND subject_id IS NULL AND subject_type = 'WORK_ORDER')
          OR
          (work_order_id IS NULL AND subject_id IS NOT NULL AND subject_type LIKE 'HANDYMAN_%')
        );
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE sla_escalation_actions
        DROP CONSTRAINT IF EXISTS sla_escalation_actions_binding_check,
        DROP COLUMN IF EXISTS subject_type,
        DROP COLUMN IF EXISTS subject_id,
        ALTER COLUMN work_order_id SET NOT NULL;
      ALTER TABLE sla_escalation_policies
        DROP CONSTRAINT sla_escalation_policies_operational_type_check,
        ADD CONSTRAINT sla_escalation_policies_operational_type_check
          CHECK (operational_type = 'WORK_ORDER');
    `);
  },
};
