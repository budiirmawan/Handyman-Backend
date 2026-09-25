import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  CreateSaasBillingAccountInput,
  SaasBillingAccountRecord,
  SaasBillingAccountStatus,
} from './platform-billing.types';

type Executor = Pick<PoolClient, 'query'> | ReturnType<typeof getPool>;

function executor(q?: Executor): Executor {
  return q ?? getPool();
}

type BillingAccountRow = {
  id: string;
  customerId: string;
  legalName: string;
  taxIdentity: string | null;
  billingAddress: Record<string, unknown>;
  billingEmail: string | null;
  currencyCode: string;
  paymentTerms: number;
  status: SaasBillingAccountStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `
  id,
  customer_id AS "customerId",
  legal_name AS "legalName",
  tax_identity AS "taxIdentity",
  billing_address AS "billingAddress",
  billing_email AS "billingEmail",
  currency_code AS "currencyCode",
  payment_terms AS "paymentTerms",
  status,
  version,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: BillingAccountRow): SaasBillingAccountRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    legalName: row.legalName,
    taxIdentity: row.taxIdentity,
    billingAddress: row.billingAddress ?? {},
    billingEmail: row.billingEmail,
    currencyCode: row.currencyCode,
    paymentTerms: row.paymentTerms,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(
  input: CreateSaasBillingAccountInput,
  q?: Executor,
): Promise<SaasBillingAccountRecord> {
  const result = await executor(q).query<BillingAccountRow>(
    `INSERT INTO saas_billing_accounts
       (id, customer_id, legal_name, tax_identity, billing_address, billing_email,
        currency_code, payment_terms, status, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', 1)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.customerId,
      input.legalName,
      input.taxIdentity ?? null,
      JSON.stringify(input.billingAddress ?? {}),
      input.billingEmail ?? null,
      input.currencyCode,
      input.paymentTerms ?? 30,
    ],
  );
  return mapRow(result.rows[0]);
}

async function findById(id: string, q?: Executor): Promise<SaasBillingAccountRecord | null> {
  const result = await executor(q).query<BillingAccountRow>(
    `SELECT ${SELECT} FROM saas_billing_accounts WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function lockById(id: string, q?: Executor): Promise<SaasBillingAccountRecord | null> {
  const result = await executor(q).query<BillingAccountRow>(
    `SELECT ${SELECT} FROM saas_billing_accounts WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findActiveByCustomerId(
  customerId: string,
  q?: Executor,
): Promise<SaasBillingAccountRecord | null> {
  const result = await executor(q).query<BillingAccountRow>(
    `SELECT ${SELECT} FROM saas_billing_accounts
      WHERE customer_id = $1 AND status = 'ACTIVE'
      ORDER BY created_at ASC
      LIMIT 1`,
    [customerId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Columns the PATCH command may write (whitelist — no open surface). */
const UPDATABLE_COLUMNS: Record<string, string> = {
  legalName: 'legal_name',
  taxIdentity: 'tax_identity',
  billingAddress: 'billing_address',
  billingEmail: 'billing_email',
  currencyCode: 'currency_code',
  paymentTerms: 'payment_terms',
  status: 'status',
};

async function updateWithVersion(
  id: string,
  columns: Record<string, unknown>,
  expectedVersion: number,
  q?: Executor,
): Promise<SaasBillingAccountRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [field, column] of Object.entries(UPDATABLE_COLUMNS)) {
    const value = columns[field];
    if (value !== undefined) {
      values.push(
        field === 'billingAddress' ? JSON.stringify(value) : value,
      );
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) return findById(id, q);

  values.push(id, expectedVersion);
  sets.push(`version = version + 1`, `updated_at = NOW()`);

  const result = await executor(q).query<BillingAccountRow>(
    `UPDATE saas_billing_accounts SET ${sets.join(', ')}
      WHERE id = $${values.length - 1} AND version = $${values.length}
      RETURNING ${SELECT}`,
    values,
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function list(
  params: { withTotal: boolean; limit?: number; offset?: number },
  q?: Executor,
): Promise<{ records: SaasBillingAccountRecord[]; total: number | null }> {
  const db = executor(q);
  let total: number | null = null;
  if (params.withTotal) {
    const countResult = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM saas_billing_accounts`,
    );
    total = countResult.rows[0]?.total ?? 0;
  }
  const limitClause = params.limit !== undefined ? `LIMIT $1` : '';
  const offsetClause = params.offset !== undefined ? `OFFSET $2` : '';
  const values: unknown[] = [];
  if (params.limit !== undefined) values.push(params.limit);
  if (params.offset !== undefined) values.push(params.offset);
  const result = await db.query<BillingAccountRow>(
    `SELECT ${SELECT} FROM saas_billing_accounts
      ORDER BY created_at DESC, id DESC
      ${limitClause} ${offsetClause}`,
    values,
  );
  return { records: result.rows.map(mapRow), total };
}

export const saasBillingAccountRepository = {
  create,
  findActiveByCustomerId,
  findById,
  list,
  lockById,
  updateWithVersion,
};
