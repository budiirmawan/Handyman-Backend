import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SLA-02 PART 02 — durable escalation action ledger.
 *
 * One row = one escalation level that was materialized for one breached SLA
 * clock. Rows are created ONLY inside the first-breach branch of a breach
 * write (lifecycle transaction or due dispatcher), never re-derived.
 *
 * WHY THE LEDGER EXISTS
 * ---------------------
 * `sla_escalation_policies` / `sla_escalation_levels` (0295/0296) are editable
 * configuration. A scheduled escalation must not change when that configuration
 * later changes, so `template_key` and `recipient_rule` are SNAPSHOTTED here at
 * materialization time and `due_at` is an absolute instant computed once from
 * the persisted `breached_at`. This mirrors why `applied_slas` snapshots the
 * SLA definition.
 *
 * IDEMPOTENCY
 * -----------
 * `UNIQUE (sla_clock_id, escalation_level_id)` is the durable duplicate guard
 * behind the first-write-idempotent `markBreached` branch: even a future code
 * path, backfill, or manual re-run cannot schedule a level twice for a clock.
 *
 * BOUNDARY
 * --------
 * No SLA-01 table is modified. Escalation never mutates Work Order state,
 * `applied_slas`, `sla_clocks`, or pause intervals. Recipient resolution,
 * notification creation, and triggering are PART 03; `triggered_at`,
 * `recipients_resolved`, `notifications_created`, and `failure_reason` are
 * written by PART 02 as defaults only.
 */
export const migration0297CreateSlaEscalationActions: Migration = {
  id: '0297_create_sla_escalation_actions',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE sla_escalation_actions (
        id UUID PRIMARY KEY,
        applied_sla_id UUID NOT NULL REFERENCES applied_slas (id),
        sla_clock_id UUID NOT NULL REFERENCES sla_clocks (id),
        work_order_id UUID NOT NULL REFERENCES work_orders (id),
        client_id UUID NOT NULL REFERENCES clients (id),
        building_id UUID NOT NULL REFERENCES buildings (id),
        clock_type TEXT NOT NULL,
        policy_id UUID NOT NULL REFERENCES sla_escalation_policies (id),
        escalation_level_id UUID NOT NULL REFERENCES sla_escalation_levels (id),
        level INTEGER NOT NULL,
        template_key TEXT NOT NULL REFERENCES notification_templates (key),
        recipient_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
        breached_at TIMESTAMPTZ NOT NULL,
        due_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        triggered_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        cancel_reason TEXT,
        recipients_resolved INTEGER NOT NULL DEFAULT 0,
        notifications_created INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT sla_escalation_actions_clock_level_unique UNIQUE (sla_clock_id, escalation_level_id),
        CONSTRAINT sla_escalation_actions_clock_type_check CHECK (clock_type IN ('RESPONSE','RESOLUTION')),
        CONSTRAINT sla_escalation_actions_level_check CHECK (level >= 1),
        CONSTRAINT sla_escalation_actions_status_check CHECK (status IN ('PENDING','TRIGGERED','CANCELLED','SKIPPED')),
        CONSTRAINT sla_escalation_actions_due_check CHECK (due_at >= breached_at),
        CONSTRAINT sla_escalation_actions_counter_check CHECK (recipients_resolved >= 0 AND notifications_created >= 0),
        CONSTRAINT sla_escalation_actions_state_check CHECK (
          (status = 'PENDING' AND triggered_at IS NULL AND cancelled_at IS NULL) OR
          (status = 'TRIGGERED' AND triggered_at IS NOT NULL AND cancelled_at IS NULL) OR
          (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND triggered_at IS NULL) OR
          (status = 'SKIPPED' AND triggered_at IS NULL)
        )
      );
      CREATE INDEX sla_escalation_actions_due_idx ON sla_escalation_actions (status, due_at) WHERE status = 'PENDING';
      CREATE INDEX sla_escalation_actions_work_order_idx ON sla_escalation_actions (work_order_id, level);
      CREATE INDEX sla_escalation_actions_client_recent_idx ON sla_escalation_actions (client_id, created_at DESC);
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS sla_escalation_actions');
  },
};
