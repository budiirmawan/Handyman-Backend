import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-COMM-VAR-01 PART 01 — Operational Budget overspend policy.
 *
 * Adds the governed overspend-control attribute to the existing CR-BE-FIN-01
 * `operational_budgets` authority. No new budget table, no new cost-category
 * master, and no commitment/actual/variance behavior is introduced here.
 *
 * - `STRICT` (default) — a future commitment may never exceed the available
 *   budget. This is the behaviour-preserving value: no commitment authority
 *   exists yet, so every existing row safely becomes `STRICT` and no
 *   historical financial meaning is rewritten.
 * - `ALLOW_WITH_OVERRIDE` — a future commitment may exceed the available
 *   budget only through the explicit override authority governed by PART 02
 *   (`operational_budget.override` plus a recorded reason and audit event).
 *
 * The policy is a declaration of intent only. PART 01 deliberately implements
 * no override transaction, no budget-row consumption check, and no permission.
 */
export const migration0310AddOperationalBudgetOverspendPolicy: Migration = {
  id: '0310_add_operational_budget_overspend_policy',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE operational_budgets
        ADD COLUMN overspend_policy TEXT NOT NULL DEFAULT 'STRICT',
        ADD CONSTRAINT operational_budgets_overspend_policy_check
          CHECK (overspend_policy IN ('STRICT', 'ALLOW_WITH_OVERRIDE'))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE operational_budgets
        DROP CONSTRAINT IF EXISTS operational_budgets_overspend_policy_check,
        DROP COLUMN IF EXISTS overspend_policy
    `);
  },
};
