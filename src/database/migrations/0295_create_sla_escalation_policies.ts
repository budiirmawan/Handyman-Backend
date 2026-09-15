import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SLA-02 PART 01 — SLA escalation policy configuration authority.
 *
 * Client-owned, optionally Building-narrowed, effective-dated configuration
 * describing WHICH breaches escalate. It is configuration only: no action
 * ledger, no breach-time materialization, no execution. SLA-01 tables
 * (`sla_definitions`, `applied_slas`, `sla_clocks`) are untouched.
 */
export const migration0295CreateSlaEscalationPolicies: Migration = {
  id: '0295_create_sla_escalation_policies',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE sla_escalation_policies (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        building_id UUID REFERENCES buildings (id),
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        operational_type TEXT NOT NULL,
        clock_type TEXT NOT NULL,
        work_type TEXT,
        priority TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        effective_from TIMESTAMPTZ NOT NULL,
        effective_to TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT sla_escalation_policies_client_code_unique UNIQUE (client_id, code),
        CONSTRAINT sla_escalation_policies_code_check CHECK (code ~ '^[A-Z][A-Z0-9_.-]*$'),
        CONSTRAINT sla_escalation_policies_operational_type_check CHECK (operational_type = 'WORK_ORDER'),
        CONSTRAINT sla_escalation_policies_clock_type_check CHECK (clock_type IN ('RESPONSE','RESOLUTION','ANY')),
        CONSTRAINT sla_escalation_policies_priority_check CHECK (priority IS NULL OR priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        CONSTRAINT sla_escalation_policies_status_check CHECK (status IN ('ACTIVE','INACTIVE')),
        CONSTRAINT sla_escalation_policies_effective_range_check CHECK (effective_to IS NULL OR effective_to > effective_from)
      );
      CREATE INDEX sla_escalation_policies_client_list_idx ON sla_escalation_policies (client_id, status, effective_from);
      CREATE INDEX sla_escalation_policies_applicability_idx ON sla_escalation_policies (client_id, building_id, operational_type, clock_type, status);
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS sla_escalation_policies');
  },
};
