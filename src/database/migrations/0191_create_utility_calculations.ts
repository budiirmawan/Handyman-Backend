import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-18I — Utility Calculation.
 *
 * Unlike BE-18H, which is a pure projection and owns nothing, a calculation
 * produces facts that exist nowhere else: an applied rate, a resulting
 * amount, and a lifecycle status. Those cannot be re-derived after the fact
 * — the basis behind them may change — so they are persisted.
 *
 * Two tables:
 *
 *   `utility_calculation_bases` — lightweight, data-driven calculation rules.
 *   One row per (Client, utility type, effective window): a rate value and
 *   the unit it applies to. This is deliberately NOT a tariff engine: no
 *   tiers, blocks, taxes, surcharges, currencies, invoices or ledgers. It is
 *   the minimum reference data needed to turn a consumption into a value, so
 *   the rule lives in data rather than in code.
 *
 *   `utility_calculations` — one calculated result per Consumption.
 *
 * Consumption is never duplicated. A calculation stores `consumption_id` and
 * the derived amount, but NOT the consumption value itself; that stays in
 * `utility_meter_consumptions`, which stays the single source of truth. The
 * BE-18E readings behind it are two hops away and are never copied here
 * either. `period_start` / `period_end` mirror the consumption's period for
 * the same reason BE-18G mirrors the readings' instants: so a period can be
 * filtered without a join. They are constrained to be strictly ordered.
 *
 * `applied_rate_value` IS snapshotted, and that is not a duplication of the
 * basis — it is the whole point. A basis is versioned reference data that can
 * be superseded; a finalized result must remain explainable years later, so
 * the rate actually applied is frozen onto the row alongside a reference to
 * the basis it came from.
 *
 * History and finalization:
 *
 *   DRAFT → FINALIZED    finalizing freezes the result
 *   DRAFT → SUPERSEDED   recalculation replaces a draft with a new row
 *
 * Recalculation never mutates a prior result in place. It writes a NEW row
 * that points back at its predecessor via `supersedes_calculation_id` and
 * marks the predecessor SUPERSEDED, so the full calculation history is
 * preserved and auditable. A FINALIZED row is terminal: it can never be
 * recalculated, re-finalized, or superseded — the service refuses, and the
 * partial unique index below makes a second live result for the same
 * consumption impossible even under a concurrent race.
 *
 * Out of scope, deliberately: invoicing, tax, payment, accounting, dunning,
 * allocation between tenants, and Abnormal Consumption (BE-18J). Billing
 * never lives in BE-18.
 */
export const migration0191CreateUtilityCalculations: Migration = {
  id: '0191_create_utility_calculations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE utility_calculation_bases (
        id               UUID PRIMARY KEY,
        client_id        UUID NOT NULL REFERENCES clients (id),
        utility_type     TEXT NOT NULL,
        name             TEXT NOT NULL,
        description      TEXT,
        uom_id           UUID REFERENCES units_of_measure (id),
        rate_value       NUMERIC NOT NULL,
        rate_label       TEXT,
        effective_from   TIMESTAMPTZ NOT NULL,
        effective_to     TIMESTAMPTZ,
        status           TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_calculation_bases_type_check
          CHECK (utility_type IN ('ELECTRICITY', 'WATER', 'GAS')),
        CONSTRAINT utility_calculation_bases_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT utility_calculation_bases_rate_check
          CHECK (rate_value >= 0),
        CONSTRAINT utility_calculation_bases_window_check
          CHECK (effective_to IS NULL OR effective_to > effective_from)
      )
    `);

    await client.query(`
      CREATE INDEX utility_calculation_bases_lookup_idx
        ON utility_calculation_bases
           (client_id, utility_type, status, effective_from DESC)
    `);

    await client.query(`
      CREATE TABLE utility_calculations (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        meter_id              UUID NOT NULL REFERENCES utility_meters (id),
        utility_type          TEXT NOT NULL,
        consumption_id        UUID NOT NULL
          REFERENCES utility_meter_consumptions (id),
        calculation_basis_id  UUID REFERENCES utility_calculation_bases (id),
        applied_rate_value    NUMERIC NOT NULL,
        calculated_amount     NUMERIC NOT NULL,
        uom_id                UUID NOT NULL REFERENCES units_of_measure (id),
        period_start          TIMESTAMPTZ NOT NULL,
        period_end            TIMESTAMPTZ NOT NULL,
        status                TEXT NOT NULL DEFAULT 'DRAFT',
        calculated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        calculated_by_user_id UUID REFERENCES users (id),
        finalized_at          TIMESTAMPTZ,
        finalized_by_user_id  UUID REFERENCES users (id),
        supersedes_calculation_id UUID REFERENCES utility_calculations (id),
        tenant_assignment_id  UUID
          REFERENCES utility_meter_tenant_assignments (id),
        tenant_company_id     UUID REFERENCES tenant_companies (id),
        notes                 TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_calculations_type_check
          CHECK (utility_type IN ('ELECTRICITY', 'WATER', 'GAS')),
        CONSTRAINT utility_calculations_status_check
          CHECK (status IN ('DRAFT', 'FINALIZED', 'SUPERSEDED')),
        CONSTRAINT utility_calculations_period_check
          CHECK (period_end > period_start),
        CONSTRAINT utility_calculations_rate_check
          CHECK (applied_rate_value >= 0),
        CONSTRAINT utility_calculations_amount_check
          CHECK (calculated_amount >= 0),
        -- FINALIZED is the only status that may carry finalization stamps.
        CONSTRAINT utility_calculations_finalized_check
          CHECK (
            (status = 'FINALIZED' AND finalized_at IS NOT NULL)
            OR (status <> 'FINALIZED' AND finalized_at IS NULL)
          )
      )
    `);

    // At most one live (DRAFT or FINALIZED) result per Consumption. Superseded
    // rows are exempt, so history accumulates freely while a concurrent
    // double-calculate can never produce two competing live figures.
    await client.query(`
      CREATE UNIQUE INDEX utility_calculations_live_consumption_unique
        ON utility_calculations (consumption_id)
        WHERE status <> 'SUPERSEDED'
    `);

    await client.query(`
      CREATE INDEX utility_calculations_meter_period_idx
        ON utility_calculations (meter_id, period_end DESC);
      CREATE INDEX utility_calculations_building_idx
        ON utility_calculations (building_id, period_end DESC);
      CREATE INDEX utility_calculations_client_idx
        ON utility_calculations (client_id, period_end DESC);
      CREATE INDEX utility_calculations_tenant_idx
        ON utility_calculations (tenant_company_id, period_end DESC);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS utility_calculations');
    await client.query('DROP TABLE IF EXISTS utility_calculation_bases');
  },
};
