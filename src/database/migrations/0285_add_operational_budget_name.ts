import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-FIN-01 PART 05 — stable Operational Finance read identity.
 *
 * PART 05 exposes a budgetName in the additive read contract. Existing PART 01
 * budgets receive a neutral, non-financial default; callers may provide a
 * meaningful name while a budget is still DRAFT. This is identity metadata,
 * not a new accounting dimension.
 */
export const migration0285AddOperationalBudgetName: Migration = {
  id: '0285_add_operational_budget_name',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE operational_budgets
        ADD COLUMN budget_name TEXT NOT NULL DEFAULT 'Operational Budget',
        ADD CONSTRAINT operational_budgets_name_check
          CHECK (length(btrim(budget_name)) BETWEEN 1 AND 160)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE operational_budgets
        DROP CONSTRAINT IF EXISTS operational_budgets_name_check,
        DROP COLUMN IF EXISTS budget_name
    `);
  },
};
