import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** CR-BE-SLA-01 PART 01 — configuration authority only; no applied SLA or clock. */
export const migration0291CreateSlaDefinitions: Migration = {
  id: '0291_create_sla_definitions',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE sla_definitions (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        building_id UUID REFERENCES buildings (id),
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        operational_type TEXT NOT NULL,
        work_type TEXT,
        priority TEXT,
        response_target_minutes INTEGER,
        resolution_target_minutes INTEGER,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        effective_from TIMESTAMPTZ NOT NULL,
        effective_to TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT sla_definitions_client_code_unique UNIQUE (client_id, code),
        CONSTRAINT sla_definitions_code_check CHECK (code ~ '^[A-Z][A-Z0-9_.-]*$'),
        CONSTRAINT sla_definitions_operational_type_check CHECK (operational_type = 'WORK_ORDER'),
        CONSTRAINT sla_definitions_priority_check CHECK (priority IS NULL OR priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        CONSTRAINT sla_definitions_response_target_check CHECK (response_target_minutes IS NULL OR response_target_minutes > 0),
        CONSTRAINT sla_definitions_resolution_target_check CHECK (resolution_target_minutes IS NULL OR resolution_target_minutes > 0),
        CONSTRAINT sla_definitions_target_check CHECK (response_target_minutes IS NOT NULL OR resolution_target_minutes IS NOT NULL),
        CONSTRAINT sla_definitions_status_check CHECK (status IN ('ACTIVE','INACTIVE')),
        CONSTRAINT sla_definitions_effective_range_check CHECK (effective_to IS NULL OR effective_to > effective_from)
      );
      CREATE INDEX sla_definitions_client_list_idx ON sla_definitions (client_id, status, operational_type, effective_from);
      CREATE INDEX sla_definitions_building_list_idx ON sla_definitions (building_id, status, effective_from) WHERE building_id IS NOT NULL;
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS sla_definitions');
  },
};
