import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import {
  operationalBudgetCategoryHasSourceBindingsError,
  operationalBudgetCategoryNotDraftError,
  operationalBudgetCategoryTotalExceedsError,
  operationalBudgetCategoryTotalMismatchError,
} from './operational-finance.errors';
import type {
  NewOperationalBudget,
  NewOperationalBudgetCategory,
  OperationalBudgetCategoryRecord,
  OperationalBudgetFilters,
  OperationalBudgetRecord,
  OperationalBudgetStatus,
  UpdateOperationalBudgetCategoryInput,
  UpdateOperationalBudgetInput,
} from './operational-finance.types';

type BudgetRow = {
  id: string;
  budgetName: string;
  clientId: string;
  buildingId: string;
  periodStart: string;
  periodEnd: string;
  currency: OperationalBudgetRecord['currency'];
  plannedAmount: string;
  status: OperationalBudgetStatus;
  overspendPolicy: OperationalBudgetRecord['overspendPolicy'];
  createdAt: Date;
  updatedAt: Date;
};

type CategoryRow = {
  id: string;
  budgetId: string;
  code: string;
  name: string;
  plannedAmount: string;
  createdAt: Date;
  updatedAt: Date;
};

const BUDGET_SELECT = `
  id,
  budget_name AS "budgetName",
  client_id AS "clientId",
  building_id AS "buildingId",
  period_start::text AS "periodStart",
  period_end::text AS "periodEnd",
  currency,
  planned_amount::text AS "plannedAmount",
  status,
  overspend_policy AS "overspendPolicy",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const CATEGORY_SELECT = `
  id,
  budget_id AS "budgetId",
  category_code AS code,
  name,
  planned_amount::text AS "plannedAmount",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapBudget(row: BudgetRow): OperationalBudgetRecord {
  return {
    id: row.id,
    budgetName: row.budgetName,
    clientId: row.clientId,
    buildingId: row.buildingId,
    budgetPeriod: { start: row.periodStart, end: row.periodEnd },
    currency: row.currency,
    plannedAmount: Number(row.plannedAmount),
    status: row.status,
    overspendPolicy: row.overspendPolicy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapCategory(row: CategoryRow): OperationalBudgetCategoryRecord {
  return {
    id: row.id,
    budgetId: row.budgetId,
    code: row.code,
    name: row.name,
    plannedAmount: Number(row.plannedAmount),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createBudget(
  input: NewOperationalBudget,
): Promise<OperationalBudgetRecord> {
  const result = await getPool().query<BudgetRow>(
    `INSERT INTO operational_budgets
       (id, budget_name, client_id, building_id, period_start, period_end, currency, planned_amount, overspend_policy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING ${BUDGET_SELECT}`,
    [
      randomUUID(),
      input.budgetName,
      input.clientId,
      input.buildingId,
      input.budgetPeriod.start,
      input.budgetPeriod.end,
      input.currency,
      input.plannedAmount,
      input.overspendPolicy,
    ],
  );
  return mapBudget(result.rows[0]);
}

async function findBudgetById(
  id: string,
): Promise<OperationalBudgetRecord | null> {
  const result = await getPool().query<BudgetRow>(
    `SELECT ${BUDGET_SELECT} FROM operational_budgets WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapBudget(result.rows[0]) : null;
}

async function listBudgets(
  filters: OperationalBudgetFilters,
  buildingIds: string[],
): Promise<OperationalBudgetRecord[]> {
  if (buildingIds.length === 0) return [];

  const values: unknown[] = [buildingIds];
  const clauses = ['building_id = ANY($1::uuid[])'];

  if (filters.buildingId !== undefined) {
    values.push(filters.buildingId);
    clauses.push(`building_id = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }
  if (filters.periodFrom !== undefined) {
    values.push(filters.periodFrom);
    clauses.push(`period_end >= $${values.length}::date`);
  }
  if (filters.periodTo !== undefined) {
    values.push(filters.periodTo);
    clauses.push(`period_start <= $${values.length}::date`);
  }

  const result = await getPool().query<BudgetRow>(
    `SELECT ${BUDGET_SELECT} FROM operational_budgets
     WHERE ${clauses.join(' AND ')}
     ORDER BY period_start DESC, created_at DESC, id`,
    values,
  );
  return result.rows.map(mapBudget);
}

type LockedBudgetRow = {
  plannedAmount: string;
  status: OperationalBudgetStatus;
};

async function lockBudget(
  client: Pick<PoolClient, 'query'>,
  id: string,
): Promise<LockedBudgetRow | null> {
  const result = await client.query<LockedBudgetRow>(
    `SELECT planned_amount::text AS "plannedAmount", status
       FROM operational_budgets
      WHERE id = $1
      FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function categoryPlannedTotal(
  client: Pick<PoolClient, 'query'>,
  budgetId: string,
): Promise<string> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(planned_amount), 0)::text AS total
       FROM operational_budget_categories
      WHERE budget_id = $1`,
    [budgetId],
  );
  return result.rows[0]?.total ?? '0';
}

async function assertCategoryTotalFits(
  client: Pick<PoolClient, 'query'>,
  budgetId: string,
  categoryPlannedAmount: number | string,
): Promise<void> {
  const budget = await lockBudget(client, budgetId);
  if (!budget || budget.status !== 'DRAFT') {
    throw operationalBudgetCategoryNotDraftError();
  }

  const total = await categoryPlannedTotal(client, budgetId);
  const result = await client.query<{ allowed: boolean }>(
    `SELECT ($1::numeric + $2::numeric <= $3::numeric) AS allowed`,
    [total, categoryPlannedAmount, budget.plannedAmount],
  );
  if (!result.rows[0]?.allowed) {
    throw operationalBudgetCategoryTotalExceedsError();
  }
}

async function updateBudget(
  id: string,
  input: UpdateOperationalBudgetInput,
): Promise<OperationalBudgetRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];

  if (input.budgetName !== undefined) {
    values.push(input.budgetName);
    sets.push(`budget_name = $${values.length}`);
  }
  if (input.budgetPeriod !== undefined) {
    values.push(input.budgetPeriod.start);
    sets.push(`period_start = $${values.length}`);
    values.push(input.budgetPeriod.end);
    sets.push(`period_end = $${values.length}`);
  }
  if (input.currency !== undefined) {
    values.push(input.currency);
    sets.push(`currency = $${values.length}`);
  }
  if (input.plannedAmount !== undefined) {
    values.push(input.plannedAmount);
    sets.push(`planned_amount = $${values.length}`);
  }
  if (input.overspendPolicy !== undefined) {
    values.push(input.overspendPolicy);
    sets.push(`overspend_policy = $${values.length}`);
  }

  if (sets.length === 0) return findBudgetById(id);

  return withTransaction(async (client) => {
    const budget = await lockBudget(client, id);
    if (!budget || budget.status !== 'DRAFT') return null;

    if (input.plannedAmount !== undefined) {
      const total = await categoryPlannedTotal(client, id);
      const result = await client.query<{ allowed: boolean }>(
        `SELECT ($1::numeric >= $2::numeric) AS allowed`,
        [input.plannedAmount, total],
      );
      if (!result.rows[0]?.allowed) {
        throw operationalBudgetCategoryTotalExceedsError();
      }
    }

    const updateValues = [...values, id];
    sets.push('updated_at = NOW()');
    const result = await client.query<BudgetRow>(
      `UPDATE operational_budgets SET ${sets.join(', ')}
       WHERE id = $${updateValues.length} AND status = 'DRAFT'
       RETURNING ${BUDGET_SELECT}`,
      updateValues,
    );
    return result.rows[0] ? mapBudget(result.rows[0]) : null;
  });
}

async function transitionBudget(
  id: string,
  from: OperationalBudgetStatus,
  to: OperationalBudgetStatus,
): Promise<OperationalBudgetRecord | null> {
  return withTransaction(async (client) => {
    const budget = await lockBudget(client, id);
    if (!budget || budget.status !== from) return null;

    if (to === 'ACTIVE') {
      const total = await categoryPlannedTotal(client, id);
      const result = await client.query<{ allowed: boolean }>(
        `SELECT ($1::numeric = $2::numeric) AS allowed`,
        [total, budget.plannedAmount],
      );
      if (!result.rows[0]?.allowed) {
        throw operationalBudgetCategoryTotalMismatchError();
      }
    }

    const result = await client.query<BudgetRow>(
      `UPDATE operational_budgets
          SET status = $2, updated_at = NOW()
        WHERE id = $1 AND status = $3
        RETURNING ${BUDGET_SELECT}`,
      [id, to, from],
    );
    return result.rows[0] ? mapBudget(result.rows[0]) : null;
  });
}

async function createCategory(
  input: NewOperationalBudgetCategory,
): Promise<OperationalBudgetCategoryRecord> {
  return withTransaction(async (client) => {
    await assertCategoryTotalFits(client, input.budgetId, input.plannedAmount);
    const result = await client.query<CategoryRow>(
      `INSERT INTO operational_budget_categories
         (id, budget_id, category_code, name, planned_amount)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING ${CATEGORY_SELECT}`,
      [
        randomUUID(),
        input.budgetId,
        input.code,
        input.name,
        input.plannedAmount,
      ],
    );
    return mapCategory(result.rows[0]);
  });
}

async function findCategoryById(
  id: string,
): Promise<OperationalBudgetCategoryRecord | null> {
  const result = await getPool().query<CategoryRow>(
    `SELECT ${CATEGORY_SELECT} FROM operational_budget_categories WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapCategory(result.rows[0]) : null;
}

async function listCategories(
  budgetId: string,
): Promise<OperationalBudgetCategoryRecord[]> {
  const result = await getPool().query<CategoryRow>(
    `SELECT ${CATEGORY_SELECT} FROM operational_budget_categories
     WHERE budget_id = $1 ORDER BY category_code ASC, id`,
    [budgetId],
  );
  return result.rows.map(mapCategory);
}

async function updateCategory(
  id: string,
  input: UpdateOperationalBudgetCategoryInput,
): Promise<OperationalBudgetCategoryRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.plannedAmount !== undefined) {
    values.push(input.plannedAmount);
    sets.push(`planned_amount = $${values.length}`);
  }

  if (sets.length === 0) return findCategoryById(id);

  return withTransaction(async (client) => {
    const categoryBudgetResult = await client.query<{ budgetId: string }>(
      `SELECT budget_id AS "budgetId"
         FROM operational_budget_categories
        WHERE id = $1`,
      [id],
    );
    const categoryBudget = categoryBudgetResult.rows[0];
    if (!categoryBudget) return null;

    const budget = await lockBudget(client, categoryBudget.budgetId);
    if (!budget || budget.status !== 'DRAFT') {
      throw operationalBudgetCategoryNotDraftError();
    }

    const categoryResult = await client.query<{ plannedAmount: string }>(
      `SELECT planned_amount::text AS "plannedAmount"
         FROM operational_budget_categories
        WHERE id = $1
        FOR UPDATE`,
      [id],
    );
    const current = categoryResult.rows[0];
    if (!current) return null;

    const total = await categoryPlannedTotal(client, categoryBudget.budgetId);
    const proposedAmount = input.plannedAmount ?? current.plannedAmount;
    const allowed = await client.query<{ allowed: boolean }>(
      `SELECT ($1::numeric - $2::numeric + $3::numeric <= $4::numeric) AS allowed`,
      [total, current.plannedAmount, proposedAmount, budget.plannedAmount],
    );
    if (!allowed.rows[0]?.allowed) {
      throw operationalBudgetCategoryTotalExceedsError();
    }

    const updateValues = [...values, id];
    sets.push('updated_at = NOW()');
    const result = await client.query<CategoryRow>(
      `UPDATE operational_budget_categories
          SET ${sets.join(', ')}
        WHERE id = $${updateValues.length}
        RETURNING ${CATEGORY_SELECT}`,
      updateValues,
    );
    return result.rows[0] ? mapCategory(result.rows[0]) : null;
  });
}

async function deleteCategory(id: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const categoryResult = await client.query<{ budgetId: string }>(
      `SELECT budget_id AS "budgetId"
         FROM operational_budget_categories
        WHERE id = $1`,
      [id],
    );
    const current = categoryResult.rows[0];
    if (!current) return false;

    const budget = await lockBudget(client, current.budgetId);
    if (!budget || budget.status !== 'DRAFT') {
      throw operationalBudgetCategoryNotDraftError();
    }

    try {
      const result = await client.query(
        `DELETE FROM operational_budget_categories WHERE id = $1`,
        [id],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      const candidate = error as { code?: string; constraint?: string };
      if (
        candidate.code === '23503' &&
        candidate.constraint === 'operational_budget_source_binding_category_fk'
      ) {
        throw operationalBudgetCategoryHasSourceBindingsError();
      }
      throw error;
    }
  });
}

export const operationalFinanceRepository = {
  createBudget,
  createCategory,
  deleteCategory,
  findBudgetById,
  findCategoryById,
  listBudgets,
  listCategories,
  transitionBudget,
  updateBudget,
  updateCategory,
};
