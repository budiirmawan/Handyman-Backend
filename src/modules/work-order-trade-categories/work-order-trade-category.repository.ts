import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '../../database';
import type {
  CreateWorkOrderTradeCategoryInput,
  ListWorkOrderTradeCategoriesFilter,
  UpdateWorkOrderTradeCategoryInput,
  WorkOrderClassificationRecord,
  WorkOrderTradeCategoryRecord,
  WorkOrderTradeCategoryStatus,
  WorkOrderTradeRiskLevel,
} from './work-order-trade-category.types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A — trade registry repository.
 *
 * Sole writer of `work_order_trade_categories` (0465). It also owns the
 * CLASSIFICATION columns it introduced on `work_orders` (`trade_category_id`,
 * `trade_category_code`, `risk_level`, `classified_at`,
 * `classified_by_user_id`), because they are the registry's vocabulary; the
 * rest of the Work Order row stays owned by `work-orders` and its public shape
 * is deliberately unchanged (classification is its own resource).
 *
 * `trade_category_code` is written as an immutable SNAPSHOT alongside the FK:
 * a decision recorded today must stay explainable even if the category is
 * renamed tomorrow.
 */

type Row = QueryResultRow;

const SELECT = `
  SELECT tc.id,
         tc.code,
         tc.name,
         tc.description,
         tc.risk_level,
         tc.handyman_discipline_id,
         hd.code AS handyman_discipline_code,
         tc.status,
         tc.created_by_user_id,
         tc.created_at,
         tc.updated_at
    FROM work_order_trade_categories tc
    LEFT JOIN handyman_disciplines hd ON hd.id = tc.handyman_discipline_id`;

const CLASSIFICATION_SELECT = `
  SELECT wo.id                AS work_order_id,
         wo.client_id         AS client_id,
         wo.building_id       AS building_id,
         wo.trade_category_id,
         wo.trade_category_code,
         tc.name              AS trade_category_name,
         wo.risk_level,
         wo.classified_at,
         wo.classified_by_user_id
    FROM work_orders wo
    LEFT JOIN work_order_trade_categories tc
      ON tc.id = wo.trade_category_id`;

function mapRow(row: Row): WorkOrderTradeCategoryRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    riskLevel: row.risk_level as WorkOrderTradeRiskLevel,
    handymanDisciplineId: row.handyman_discipline_id ?? null,
    handymanDisciplineCode: row.handyman_discipline_code ?? null,
    status: row.status as WorkOrderTradeCategoryStatus,
    createdByUserId: row.created_by_user_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapClassification(row: Row): WorkOrderClassificationRecord {
  return {
    workOrderId: row.work_order_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    tradeCategoryId: row.trade_category_id ?? null,
    tradeCategoryCode: row.trade_category_code ?? null,
    tradeCategoryName: row.trade_category_name ?? null,
    riskLevel: (row.risk_level as WorkOrderTradeRiskLevel | null) ?? null,
    classifiedAt: toIso(row.classified_at),
    classifiedByUserId: row.classified_by_user_id ?? null,
  };
}

async function list(
  executor: Pick<PoolClient, 'query'> = getPool(),
  filter: ListWorkOrderTradeCategoriesFilter = {},
): Promise<WorkOrderTradeCategoryRecord[]> {
  const result = await executor.query(
    `${SELECT}
      WHERE ($1::text IS NULL OR tc.status = $1)
        AND ($2::text IS NULL OR tc.risk_level = $2)
        AND ($3::uuid IS NULL OR tc.handyman_discipline_id = $3)
      ORDER BY tc.code ASC`,
    [
      filter.status ?? null,
      filter.riskLevel ?? null,
      filter.handymanDisciplineId ?? null,
    ],
  );
  return result.rows.map(mapRow);
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<WorkOrderTradeCategoryRecord | null> {
  const result = await executor.query(`${SELECT} WHERE tc.id = $1`, [id]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function findByCode(
  executor: Pick<PoolClient, 'query'> = getPool(),
  code: string,
): Promise<WorkOrderTradeCategoryRecord | null> {
  const result = await executor.query(
    `${SELECT} WHERE upper(tc.code) = upper($1)`,
    [code],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function insert(
  executor: Pick<PoolClient, 'query'>,
  input: CreateWorkOrderTradeCategoryInput,
): Promise<WorkOrderTradeCategoryRecord> {
  const result = await executor.query(
    `INSERT INTO work_order_trade_categories (
       id, code, name, description, risk_level, handyman_discipline_id,
       status, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)
     RETURNING id`,
    [
      randomUUID(),
      input.code,
      input.name,
      input.description,
      input.riskLevel,
      input.handymanDisciplineId,
      input.createdByUserId,
    ],
  );
  const created = await findById(executor, result.rows[0].id);
  if (!created) {
    throw new Error(
      'WORK_ORDER_TRADE_CATEGORY_PERSIST_FAILED: insert committed no row',
    );
  }
  return created;
}

async function update(
  executor: Pick<PoolClient, 'query'>,
  id: string,
  changes: UpdateWorkOrderTradeCategoryInput,
): Promise<WorkOrderTradeCategoryRecord | null> {
  const result = await executor.query(
    `UPDATE work_order_trade_categories
        SET name = COALESCE($2, name),
            description = CASE WHEN $3::boolean THEN $4 ELSE description END,
            risk_level = COALESCE($5, risk_level),
            handyman_discipline_id =
              CASE WHEN $6::boolean THEN $7 ELSE handyman_discipline_id END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id`,
    [
      id,
      changes.name ?? null,
      changes.description !== undefined,
      changes.description ?? null,
      changes.riskLevel ?? null,
      changes.handymanDisciplineId !== undefined,
      changes.handymanDisciplineId ?? null,
    ],
  );
  if (!result.rows[0]) return null;
  return findById(executor, id);
}

async function setStatus(
  executor: Pick<PoolClient, 'query'>,
  id: string,
  status: WorkOrderTradeCategoryStatus,
): Promise<WorkOrderTradeCategoryRecord | null> {
  const result = await executor.query(
    `UPDATE work_order_trade_categories
        SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id`,
    [id, status],
  );
  if (!result.rows[0]) return null;
  return findById(executor, id);
}

async function findClassification(
  executor: Pick<PoolClient, 'query'> = getPool(),
  workOrderId: string,
): Promise<WorkOrderClassificationRecord | null> {
  const result = await executor.query(
    `${CLASSIFICATION_SELECT} WHERE wo.id = $1`,
    [workOrderId],
  );
  return result.rows[0] ? mapClassification(result.rows[0]) : null;
}

/**
 * Writes the classification in ONE statement. `tradeCategoryId: null` clears
 * it (and both the code snapshot and the risk level), returning the Work Order
 * to the unrestricted path required by the CR.
 */
async function classify(
  executor: Pick<PoolClient, 'query'>,
  input: {
    workOrderId: string;
    tradeCategoryId: string | null;
    tradeCategoryCode: string | null;
    riskLevel: WorkOrderTradeRiskLevel | null;
    actorUserId: string;
  },
): Promise<WorkOrderClassificationRecord | null> {
  const result = await executor.query(
    `UPDATE work_orders
        SET trade_category_id = $2,
            trade_category_code = $3,
            risk_level = $4,
            classified_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE NOW() END,
            classified_by_user_id =
              CASE WHEN $2::uuid IS NULL THEN NULL ELSE $5::uuid END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id`,
    [
      input.workOrderId,
      input.tradeCategoryId,
      input.tradeCategoryCode,
      input.riskLevel,
      input.actorUserId,
    ],
  );
  if (!result.rows[0]) return null;
  return findClassification(executor, input.workOrderId);
}

export const workOrderTradeCategoryRepository = {
  classify,
  findById,
  findByCode,
  findClassification,
  insert,
  list,
  setStatus,
  update,
};
