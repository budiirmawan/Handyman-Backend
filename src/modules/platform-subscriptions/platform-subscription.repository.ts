import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  BillingCycle,
  ListSaasSubscriptionFilters,
  SaasSubscriptionRecord,
  SaasSubscriptionStorageStatus,
} from './platform-subscription.types';

/** INSERT shape for new control-plane rows (always DRAFT, version 1). */
export type NewSaasSubscription = {
  clientId: string;
  code: string;
  /** Server-filled display alias of the package code (frozen §11.1). */
  planCode: string;
  productId: string;
  packageId: string;
  pricebookVersionId: string;
  billingCycle: BillingCycle;
  /** Resolved from the bound price item (never client-authoritative). */
  currencyCode: string;
  startsAt: Date;
  trialEndDate?: Date;
};

/** Any executor: the pool, or the caller's open transaction client. */
type Q = Pick<PoolClient, 'query'> | ReturnType<typeof getPool>;
function executor(q?: Q): Q {
  return q ?? getPool();
}

type SubscriptionRow = {
  id: string;
  clientId: string;
  code: string;
  planCode: string;
  productId: string | null;
  packageId: string | null;
  pricebookVersionId: string | null;
  billingCycle: string | null;
  currencyCode: string | null;
  status: string;
  startsAt: Date;
  endsAt: Date | null;
  trialEndDate: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  renewalDate: Date | null;
  graceUntil: Date | null;
  cancelledAt: Date | null;
  terminatedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

const SUBSCRIPTION_SELECT = `
  id,
  client_id AS "clientId",
  code,
  plan_code AS "planCode",
  product_id AS "productId",
  package_id AS "packageId",
  pricebook_version_id AS "pricebookVersionId",
  billing_cycle AS "billingCycle",
  currency_code AS "currencyCode",
  status,
  starts_at AS "startsAt",
  ends_at AS "endsAt",
  trial_end_date AS "trialEndDate",
  current_period_start AS "currentPeriodStart",
  current_period_end AS "currentPeriodEnd",
  renewal_date AS "renewalDate",
  grace_until AS "graceUntil",
  cancelled_at AS "cancelledAt",
  terminated_at AS "terminatedAt",
  version,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: SubscriptionRow): SaasSubscriptionRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    code: row.code,
    planCode: row.planCode,
    productId: row.productId,
    packageId: row.packageId,
    pricebookVersionId: row.pricebookVersionId,
    billingCycle: row.billingCycle as SaasSubscriptionRecord['billingCycle'],
    currencyCode: row.currencyCode,
    status: row.status as SaasSubscriptionStorageStatus,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    trialEndDate: row.trialEndDate,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    renewalDate: row.renewalDate,
    graceUntil: row.graceUntil,
    cancelledAt: row.cancelledAt,
    terminatedAt: row.terminatedAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(
  input: NewSaasSubscription,
  q?: Q,
): Promise<SaasSubscriptionRecord> {
  const result = await executor(q).query<SubscriptionRow>(
    `INSERT INTO subscriptions
       (id, client_id, code, plan_code, product_id, package_id,
        pricebook_version_id, billing_cycle, currency_code,
        status, starts_at, trial_end_date, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'DRAFT', $10, $11, 1)
     RETURNING ${SUBSCRIPTION_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.planCode,
      input.productId,
      input.packageId,
      input.pricebookVersionId,
      input.billingCycle,
      input.currencyCode,
      input.startsAt,
      input.trialEndDate ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('subscription insert returned no row');
  return mapRow(row);
}

async function findById(
  id: string,
  q?: Q,
): Promise<SaasSubscriptionRecord | null> {
  const result = await executor(q).query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_SELECT} FROM subscriptions WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Row lock for command transactions (frozen §11.2 rule 1). */
async function lockById(
  id: string,
  q?: Q,
): Promise<SaasSubscriptionRecord | null> {
  const result = await executor(q).query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_SELECT} FROM subscriptions
      WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByClientId(
  clientId: string,
  q?: Q,
): Promise<SaasSubscriptionRecord[]> {
  const result = await executor(q).query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_SELECT} FROM subscriptions
      WHERE client_id = $1 ORDER BY created_at DESC, id DESC`,
    [clientId],
  );
  return result.rows.map(mapRow);
}

async function list(
  filters: ListSaasSubscriptionFilters,
  withTotal: boolean,
  limit?: number,
  offset?: number,
  q?: Q,
): Promise<{ records: SaasSubscriptionRecord[]; total: number | null }> {
  const db = executor(q);
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filters.customerId !== undefined) {
    values.push(filters.customerId);
    clauses.push(`client_id = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }
  if (filters.packageId !== undefined) {
    values.push(filters.packageId);
    clauses.push(`package_id = $${values.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  let total: number | null = null;
  if (withTotal) {
    const countResult = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM subscriptions ${where}`,
      values,
    );
    total = countResult.rows[0]?.total ?? 0;
  }

  // LIMIT/OFFSET parameter positions are derived from the filter value
  // count, not from the assembled array length (offset may be absent).
  const limitPos = values.length + 1;
  const offsetPos = values.length + 2;
  const listParams = [
    ...values,
    ...(limit !== undefined ? [limit] : []),
    ...(offset !== undefined ? [offset] : []),
  ];
  const limitClause = limit !== undefined ? `LIMIT $${limitPos}` : '';
  const offsetClause = offset !== undefined ? `OFFSET $${offsetPos}` : '';
  const result = await db.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_SELECT} FROM subscriptions ${where}
      ORDER BY created_at DESC, id DESC
      ${limitClause} ${offsetClause}`,
    listParams,
  );
  return { records: result.rows.map(mapRow), total };
}

/** Columns the platform commands may write (whitelist — no open surface). */
const UPDATABLE_COLUMNS: Record<string, string> = {
  status: 'status',
  trialEndDate: 'trial_end_date',
  currentPeriodStart: 'current_period_start',
  currentPeriodEnd: 'current_period_end',
  renewalDate: 'renewal_date',
  graceUntil: 'grace_until',
  cancelledAt: 'cancelled_at',
  terminatedAt: 'terminated_at',
  pricebookVersionId: 'pricebook_version_id',
};

/**
 * Applies a version-guarded update (frozen §17.3):
 * `UPDATE … SET …, version = version + 1 WHERE id = $1 AND version = $2`.
 * Zero rows → the row moved on (or vanished); the caller re-reads to
 * distinguish stale-version from not-found.
 */
async function updateWithVersion(
  id: string,
  columns: Record<string, unknown>,
  expectedVersion: number,
  q?: Q,
): Promise<SaasSubscriptionRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [field, column] of Object.entries(UPDATABLE_COLUMNS)) {
    const value = columns[field];
    if (value !== undefined) {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) return findById(id, q);

  values.push(id, expectedVersion);
  sets.push(`version = version + 1`, `updated_at = NOW()`);

  const result = await executor(q).query<SubscriptionRow>(
    `UPDATE subscriptions SET ${sets.join(', ')}
      WHERE id = $${values.length - 1} AND version = $${values.length}
      RETURNING ${SUBSCRIPTION_SELECT}`,
    values,
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Version-guarded bump with NO data-column change (frozen §17.3): used by
 * commands that mutate commercial state BELOW the subscription aggregate
 * (PART 04 entitlement override) while the route stays "ver" — stale
 * `expectedVersion` → zero rows → 409 VERSION_CONFLICT; success advances
 * the version so later stale commands conflict.
 */
async function bumpVersion(
  id: string,
  expectedVersion: number,
  q?: Q,
): Promise<SaasSubscriptionRecord | null> {
  const result = await executor(q).query<SubscriptionRow>(
    `UPDATE subscriptions
        SET version = version + 1, updated_at = NOW()
      WHERE id = $1 AND version = $2
      RETURNING ${SUBSCRIPTION_SELECT}`,
    [id, expectedVersion],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const platformSubscriptionRepository = {
  bumpVersion,
  create,
  findById,
  lockById,
  findByClientId,
  list,
  updateWithVersion,
};
