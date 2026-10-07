import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-19A — Tenant Charges.
 *
 * Lightweight operational charges only. Tenant, Building and Space remain
 * authoritative in BE-14/BE-04; this table references them and does not copy
 * their master data. Charge types are validated data codes rather than a
 * hard-coded accounting taxonomy. No invoice, payment, ledger or accounting
 * entries are created here.
 *
 * Changes are snapshotted to tenant_charge_history. Charges are never deleted;
 * cancellation is terminal and preserves the complete operational record.
 */
export const migration0195CreateTenantCharges: Migration = {
  id: '0195_create_tenant_charges',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE tenant_charges (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL REFERENCES clients (id),
        tenant_company_id    UUID NOT NULL REFERENCES tenant_companies (id),
        building_id          UUID NOT NULL REFERENCES buildings (id),
        space_id             UUID NOT NULL REFERENCES spaces (id),
        charge_type          TEXT NOT NULL,
        description          TEXT NOT NULL,
        amount               NUMERIC(18,2) NOT NULL,
        charge_date          DATE NOT NULL,
        due_date             DATE,
        status               TEXT NOT NULL DEFAULT 'ACTIVE',
        reference            TEXT,
        notes                TEXT,
        created_by_user_id   UUID NOT NULL REFERENCES users (id),
        cancelled_at         TIMESTAMPTZ,
        cancelled_by_user_id UUID REFERENCES users (id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_charges_amount_check CHECK (amount >= 0),
        CONSTRAINT tenant_charges_date_check
          CHECK (due_date IS NULL OR due_date >= charge_date),
        CONSTRAINT tenant_charges_status_check
          CHECK (status IN ('ACTIVE', 'CANCELLED')),
        CONSTRAINT tenant_charges_cancel_state_check CHECK (
          (status = 'ACTIVE' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
          OR
          (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL)
        )
      )
    `);

    await client.query(`
      CREATE INDEX tenant_charges_tenant_idx
        ON tenant_charges (tenant_company_id, charge_date DESC);
      CREATE INDEX tenant_charges_building_idx
        ON tenant_charges (building_id, charge_date DESC);
      CREATE INDEX tenant_charges_space_idx
        ON tenant_charges (space_id, charge_date DESC);
      CREATE INDEX tenant_charges_type_status_idx
        ON tenant_charges (charge_type, status, charge_date DESC);
      CREATE INDEX tenant_charges_client_idx
        ON tenant_charges (client_id, charge_date DESC)
    `);

    await client.query(`
      CREATE TABLE tenant_charge_history (
        id                   UUID PRIMARY KEY,
        tenant_charge_id     UUID NOT NULL REFERENCES tenant_charges (id),
        action               TEXT NOT NULL,
        charge_type          TEXT NOT NULL,
        description          TEXT NOT NULL,
        amount               NUMERIC(18,2) NOT NULL,
        charge_date          DATE NOT NULL,
        due_date             DATE,
        status               TEXT NOT NULL,
        reference            TEXT,
        notes                TEXT,
        changed_by_user_id   UUID NOT NULL REFERENCES users (id),
        changed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_charge_history_action_check
          CHECK (action IN ('CREATED', 'UPDATED', 'CANCELLED'))
      )
    `);
    await client.query(`
      CREATE INDEX tenant_charge_history_charge_idx
        ON tenant_charge_history (tenant_charge_id, changed_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS tenant_charge_history');
    await client.query('DROP TABLE IF EXISTS tenant_charges');
  },
};
