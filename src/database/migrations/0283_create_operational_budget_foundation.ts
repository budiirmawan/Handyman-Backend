import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-FIN-01 PART 01 — Operational Budget Foundation.
 *
 * Building-scoped operational budget control only. This migration owns no
 * operational source transactions, amounts, commitments, actuals, bindings,
 * accounting, or approval workflow. Later Finance parts may reference
 * authoritative source records without copying them here.
 *
 * Every budget has one explicit currency. Currency is deliberately not
 * inferred from any future source transaction and no conversion belongs in
 * this domain.
 */
export const migration0283CreateOperationalBudgetFoundation: Migration = {
  id: '0283_create_operational_budget_foundation',

  async up(client: PoolClient): Promise<void> {
    // The extension is already used by the Utility tariff migration, but this
    // keeps this migration safe and explicit when applied in isolation.
    await client.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

    await client.query(`
      CREATE TABLE operational_budgets (
        id                UUID PRIMARY KEY,
        client_id         UUID NOT NULL REFERENCES clients (id),
        building_id       UUID NOT NULL REFERENCES buildings (id),
        period_start      DATE NOT NULL,
        period_end        DATE NOT NULL,
        currency          VARCHAR(3) NOT NULL,
        planned_amount    NUMERIC(18, 2) NOT NULL,
        status            TEXT NOT NULL DEFAULT 'DRAFT',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT operational_budgets_period_check
          CHECK (period_end >= period_start),
        CONSTRAINT operational_budgets_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY'
          )),
        CONSTRAINT operational_budgets_planned_amount_check
          CHECK (planned_amount >= 0),
        CONSTRAINT operational_budgets_status_check
          CHECK (status IN ('DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'))
      )
    `);

    // At most one live budget period may exist for a Building. Closed and
    // cancelled budgets remain historical and do not block a replacement.
    // Currency is intentionally not part of the exclusion key: a Building
    // must not have overlapping control periods in different currencies.
    await client.query(`
      ALTER TABLE operational_budgets
        ADD CONSTRAINT operational_budgets_live_period_exclusion
        EXCLUDE USING gist (
          building_id WITH =,
          daterange(period_start, period_end + 1, '[)') WITH &&
        )
        WHERE (status IN ('DRAFT', 'ACTIVE'))
    `);

    await client.query(`
      CREATE INDEX operational_budgets_client_building_idx
        ON operational_budgets (client_id, building_id, status);
      CREATE INDEX operational_budgets_building_period_idx
        ON operational_budgets (building_id, period_start, period_end);
      CREATE INDEX operational_budgets_status_idx
        ON operational_budgets (status, period_start, period_end)
    `);

    await client.query(`
      CREATE TABLE operational_budget_categories (
        id                UUID PRIMARY KEY,
        budget_id         UUID NOT NULL
          REFERENCES operational_budgets (id) ON DELETE CASCADE,
        category_code     TEXT NOT NULL,
        name              TEXT NOT NULL,
        planned_amount    NUMERIC(18, 2) NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT operational_budget_categories_code_check
          CHECK (category_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
        CONSTRAINT operational_budget_categories_name_check
          CHECK (length(btrim(name)) > 0),
        CONSTRAINT operational_budget_categories_planned_amount_check
          CHECK (planned_amount >= 0),
        CONSTRAINT operational_budget_categories_budget_code_unique
          UNIQUE (budget_id, category_code)
      )
    `);

    await client.query(`
      CREATE INDEX operational_budget_categories_budget_idx
        ON operational_budget_categories (budget_id, category_code);
      CREATE INDEX operational_budget_categories_code_idx
        ON operational_budget_categories (category_code)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS operational_budget_categories');
    await client.query('DROP TABLE IF EXISTS operational_budgets');
  },
};
