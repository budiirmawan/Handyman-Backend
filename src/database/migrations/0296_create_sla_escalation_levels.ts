import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SLA-02 PART 01 — ordered escalation levels of a policy.
 *
 * A level says "at `offset_minutes` after the breach, notify the audience
 * described by `recipient_rule` using `template_key`". PART 01 stores and
 * validates that configuration ONLY: no recipient resolution, no notification
 * intent, no delivery, no due row. `template_key` reuses the BE-26B template
 * authority by foreign key, exactly like `notification_escalations` (0244).
 */
export const migration0296CreateSlaEscalationLevels: Migration = {
  id: '0296_create_sla_escalation_levels',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE sla_escalation_levels (
        id UUID PRIMARY KEY,
        policy_id UUID NOT NULL REFERENCES sla_escalation_policies (id) ON DELETE CASCADE,
        level INTEGER NOT NULL,
        offset_minutes INTEGER NOT NULL DEFAULT 0,
        template_key TEXT NOT NULL REFERENCES notification_templates (key),
        recipient_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT sla_escalation_levels_policy_level_unique UNIQUE (policy_id, level),
        CONSTRAINT sla_escalation_levels_level_check CHECK (level >= 1),
        CONSTRAINT sla_escalation_levels_offset_check CHECK (offset_minutes >= 0),
        CONSTRAINT sla_escalation_levels_status_check CHECK (status IN ('ACTIVE','INACTIVE'))
      );
      CREATE INDEX sla_escalation_levels_policy_order_idx ON sla_escalation_levels (policy_id, level);
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS sla_escalation_levels');
  },
};
