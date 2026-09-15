import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** CR-BE-SLA-01 PART 02 — immutable applied snapshots and neutral clocks. */
export const migration0292CreateAppliedSlasAndClocks: Migration = {
  id: '0292_create_applied_slas_and_clocks',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE applied_slas (
        id UUID PRIMARY KEY,
        sla_definition_id UUID NOT NULL REFERENCES sla_definitions (id),
        work_order_id UUID NOT NULL REFERENCES work_orders (id),
        client_id UUID NOT NULL REFERENCES clients (id),
        building_id UUID NOT NULL REFERENCES buildings (id),
        definition_code TEXT NOT NULL,
        operational_type TEXT NOT NULL,
        definition_work_type TEXT,
        definition_priority TEXT,
        work_order_work_type TEXT NOT NULL,
        work_order_priority TEXT NOT NULL,
        response_target_minutes INTEGER,
        resolution_target_minutes INTEGER,
        definition_effective_from TIMESTAMPTZ NOT NULL,
        definition_effective_to TIMESTAMPTZ,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT applied_slas_work_order_unique UNIQUE (work_order_id),
        CONSTRAINT applied_slas_operational_type_check CHECK (operational_type = 'WORK_ORDER'),
        CONSTRAINT applied_slas_targets_check CHECK (response_target_minutes IS NOT NULL OR resolution_target_minutes IS NOT NULL)
      );
      CREATE INDEX applied_slas_client_building_idx ON applied_slas (client_id, building_id, applied_at);

      CREATE TABLE sla_clocks (
        id UUID PRIMARY KEY,
        applied_sla_id UUID NOT NULL REFERENCES applied_slas (id),
        clock_type TEXT NOT NULL,
        target_minutes INTEGER NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'RUNNING',
        satisfied_at TIMESTAMPTZ,
        terminated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT sla_clocks_applied_type_unique UNIQUE (applied_sla_id, clock_type),
        CONSTRAINT sla_clocks_type_check CHECK (clock_type IN ('RESPONSE','RESOLUTION')),
        CONSTRAINT sla_clocks_target_check CHECK (target_minutes > 0),
        CONSTRAINT sla_clocks_status_check CHECK (status IN ('RUNNING','SATISFIED','TERMINATED')),
        CONSTRAINT sla_clocks_state_check CHECK (
          (status = 'RUNNING' AND satisfied_at IS NULL AND terminated_at IS NULL) OR
          (status = 'SATISFIED' AND satisfied_at IS NOT NULL AND terminated_at IS NULL) OR
          (status = 'TERMINATED' AND satisfied_at IS NULL AND terminated_at IS NOT NULL)
        )
      );
      CREATE INDEX sla_clocks_running_idx ON sla_clocks (status, started_at) WHERE status = 'RUNNING';
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS sla_clocks; DROP TABLE IF EXISTS applied_slas');
  },
};
