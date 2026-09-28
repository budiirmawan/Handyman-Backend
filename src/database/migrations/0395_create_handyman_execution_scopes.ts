import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-06 PART 05 — Handyman Execution Scope (FROZEN Decision Freeze
 * F8/F9/F10/F11/F12).
 *
 * The ONE authoritative operational target, created ONLY inside the
 * PART 04 APPROVE transaction (no other creation path; no placeholder/
 * pre-approval scope). Exactly ONE scope per approved quotation version
 * (UNIQUE approved_quotation_version_id). All authority fields are
 * server-derived snapshots of the approved quotation → request →
 * immutable attribution/location lineage chain — never caller input.
 * Initial bounded status is exactly AUTHORIZED (downstream CRs own any
 * further lifecycle: assignment/scheduling/arrival/session states are
 * NOT invented here). Execution Scope != FM work order (F12): zero FM
 * linkage. Immutable: no UPDATE/DELETE (trigger).
 */
export const migration0395CreateHandymanExecutionScopes: Migration = {
  id: '0395_create_handyman_execution_scopes',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_execution_scopes (
        id                            UUID PRIMARY KEY,
        client_id                     UUID NOT NULL
          REFERENCES clients (id),
        handyman_request_id           UUID NOT NULL,
        channel_attribution_id        UUID NOT NULL
          REFERENCES handyman_channel_attributions (id),
        quotation_id                  UUID NOT NULL
          REFERENCES handyman_quotations (id),
        approved_quotation_version_id UUID NOT NULL
          REFERENCES handyman_quotation_versions (id),
        quotation_decision_id         UUID NOT NULL
          REFERENCES handyman_quotation_decisions (id),
        tenant_company_id             UUID NOT NULL
          REFERENCES tenant_companies (id),
        tenant_pic_id                 UUID
          REFERENCES tenant_pics (id),
        building_id                   UUID NOT NULL
          REFERENCES buildings (id),
        floor_id                      UUID REFERENCES floors (id),
        area_id                       UUID REFERENCES areas (id),
        room_id                       UUID REFERENCES rooms (id),
        space_id                      UUID REFERENCES spaces (id),
        status                        TEXT NOT NULL DEFAULT 'AUTHORIZED',
        created_by_user_id            UUID NOT NULL
          REFERENCES users (id),
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_execution_scopes_status_check
          CHECK (status IN ('AUTHORIZED')),
        CONSTRAINT handyman_execution_scopes_version_unique
          UNIQUE (approved_quotation_version_id),
        CONSTRAINT handyman_execution_scopes_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_execution_scopes_scope_idx
        ON handyman_execution_scopes (client_id, handyman_request_id)
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_execution_scope_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman execution scopes are immutable authority records.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_execution_scope_no_write
        BEFORE UPDATE OR DELETE ON handyman_execution_scopes
        FOR EACH ROW
        EXECUTE FUNCTION handyman_execution_scope_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_execution_scope_no_write
        ON handyman_execution_scopes;
      DROP FUNCTION IF EXISTS handyman_execution_scope_block_mutation;
      DROP TABLE IF EXISTS handyman_execution_scopes;
    `);
  },
};
