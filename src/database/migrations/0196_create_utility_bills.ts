import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-19B — Electricity / Water Bill.
 *
 * A bill references one FINALIZED BE-18 Utility Calculation. Consumption,
 * calculated utility value, Meter and Tenant assignment stay authoritative in
 * BE-18 and are exposed by joining through calculation_id; they are not
 * independently recalculated or copied here. The bill owns only its billing
 * lifecycle, due date and the amount frozen from that finalized calculation.
 * No invoice, payment, tax, ledger or accounting entries are introduced.
 */
export const migration0196CreateUtilityBills: Migration = {
  id: '0196_create_utility_bills',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE utility_bills (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL REFERENCES clients (id),
        tenant_company_id    UUID NOT NULL REFERENCES tenant_companies (id),
        building_id          UUID NOT NULL REFERENCES buildings (id),
        meter_id             UUID NOT NULL REFERENCES utility_meters (id),
        tenant_assignment_id UUID NOT NULL
          REFERENCES utility_meter_tenant_assignments (id),
        calculation_id       UUID NOT NULL UNIQUE REFERENCES utility_calculations (id),
        utility_type         TEXT NOT NULL,
        period_start         TIMESTAMPTZ NOT NULL,
        period_end           TIMESTAMPTZ NOT NULL,
        bill_amount          NUMERIC NOT NULL,
        due_date             DATE NOT NULL,
        status               TEXT NOT NULL DEFAULT 'DRAFT',
        generated_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_bills_type_check
          CHECK (utility_type IN ('ELECTRICITY', 'WATER')),
        CONSTRAINT utility_bills_period_check CHECK (period_end > period_start),
        CONSTRAINT utility_bills_amount_check CHECK (bill_amount >= 0),
        CONSTRAINT utility_bills_due_date_check
          CHECK (due_date >= (period_end AT TIME ZONE 'UTC')::date),
        CONSTRAINT utility_bills_status_check
          CHECK (status IN ('DRAFT', 'ISSUED', 'CANCELLED')),
        CONSTRAINT utility_bills_context_period_unique
          UNIQUE (tenant_company_id, meter_id, period_start, period_end)
      )
    `);
    await client.query(`
      CREATE INDEX utility_bills_tenant_idx
        ON utility_bills (tenant_company_id, period_end DESC);
      CREATE INDEX utility_bills_building_idx
        ON utility_bills (building_id, period_end DESC);
      CREATE INDEX utility_bills_meter_idx
        ON utility_bills (meter_id, period_end DESC);
      CREATE INDEX utility_bills_type_status_idx
        ON utility_bills (utility_type, status, period_end DESC);
      CREATE INDEX utility_bills_client_idx
        ON utility_bills (client_id, period_end DESC)
    `);

    await client.query(`
      CREATE TABLE utility_bill_history (
        id                 UUID PRIMARY KEY,
        utility_bill_id    UUID NOT NULL REFERENCES utility_bills (id),
        action             TEXT NOT NULL,
        bill_amount        NUMERIC NOT NULL,
        due_date           DATE NOT NULL,
        status             TEXT NOT NULL,
        changed_by_user_id UUID NOT NULL REFERENCES users (id),
        changed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_bill_history_action_check
          CHECK (action IN ('CREATED', 'UPDATED'))
      )
    `);
    await client.query(`
      CREATE INDEX utility_bill_history_bill_idx
        ON utility_bill_history (utility_bill_id, changed_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS utility_bill_history');
    await client.query('DROP TABLE IF EXISTS utility_bills');
  },
};
