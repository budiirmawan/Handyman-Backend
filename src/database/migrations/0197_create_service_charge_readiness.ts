import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-19C — Service Charge Readiness.
 *
 * Preparation snapshots only. Tenant/Building/Space remain authoritative in
 * BE-14 and an optional charge reference reuses BE-19A. No amount calculation,
 * invoice, payment, tax, ledger or accounting behavior is introduced.
 */
export const migration0197CreateServiceChargeReadiness: Migration = {
  id: '0197_create_service_charge_readiness',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE service_charge_readiness (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        tenant_company_id      UUID NOT NULL REFERENCES tenant_companies (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        space_id               UUID NOT NULL REFERENCES spaces (id),
        service_charge_type    TEXT NOT NULL,
        charge_basis           TEXT,
        tenant_charge_id       UUID REFERENCES tenant_charges (id),
        effective_from         DATE NOT NULL,
        effective_to           DATE NOT NULL,
        readiness_status       TEXT NOT NULL,
        notes                  TEXT,
        evaluated_by_user_id   UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT service_charge_readiness_period_check
          CHECK (effective_to >= effective_from),
        CONSTRAINT service_charge_readiness_status_check
          CHECK (readiness_status IN ('READY', 'NOT_READY', 'INCOMPLETE')),
        CONSTRAINT service_charge_readiness_context_period_unique
          UNIQUE (tenant_company_id, building_id, space_id,
                  service_charge_type, effective_from, effective_to)
      )
    `);
    await client.query(`
      CREATE INDEX service_charge_readiness_tenant_idx
        ON service_charge_readiness (tenant_company_id, effective_from DESC);
      CREATE INDEX service_charge_readiness_building_idx
        ON service_charge_readiness (building_id, effective_from DESC);
      CREATE INDEX service_charge_readiness_space_idx
        ON service_charge_readiness (space_id, effective_from DESC);
      CREATE INDEX service_charge_readiness_status_idx
        ON service_charge_readiness (readiness_status, effective_from DESC);
      CREATE INDEX service_charge_readiness_charge_idx
        ON service_charge_readiness (tenant_charge_id)
    `);

    await client.query(`
      CREATE TABLE service_charge_readiness_history (
        id                          UUID PRIMARY KEY,
        service_charge_readiness_id UUID NOT NULL REFERENCES service_charge_readiness (id),
        action                      TEXT NOT NULL,
        service_charge_type         TEXT NOT NULL,
        charge_basis                TEXT,
        tenant_charge_id            UUID REFERENCES tenant_charges (id),
        effective_from              DATE NOT NULL,
        effective_to                DATE NOT NULL,
        readiness_status            TEXT NOT NULL,
        notes                       TEXT,
        changed_by_user_id          UUID NOT NULL REFERENCES users (id),
        changed_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT service_charge_readiness_history_action_check
          CHECK (action IN ('CREATED', 'UPDATED'))
      )
    `);
    await client.query(`
      CREATE INDEX service_charge_readiness_history_record_idx
        ON service_charge_readiness_history
          (service_charge_readiness_id, changed_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS service_charge_readiness_history');
    await client.query('DROP TABLE IF EXISTS service_charge_readiness');
  },
};
