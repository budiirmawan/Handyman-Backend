import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  CreateSaaSCustomerInput,
  ListSaaSCustomerFilters,
  SaaSCustomerRecord,
  SaaSCustomerStorageStatus,
  UpdateSaaSCustomerInput,
} from './platform-customer.types';

/**
 * CR-BE-SAAS-01 PART 01 — SaaS Customer repository.
 *
 * Reads/writes the EXISTING `clients` table (frozen contract §2: the SaaS
 * Customer IS the client row). No second customer table is created. Every
 * function accepts an optional transaction executor so commands can run
 * inside the caller's transaction (idempotency, lifecycle commands).
 */

/** Any executor: the pool, or the caller's open transaction client. */
type Q = Pick<PoolClient, 'query'> | ReturnType<typeof getPool>;

type CustomerRow = {
  id: string;
  code: string;
  name: string;
  legal_name: string | null;
  display_name: string | null;
  tax_id: string | null;
  description: string | null;
  status: SaaSCustomerStorageStatus;
  billing_email: string | null;
  billing_phone: string | null;
  address: string | null;
  country: string | null;
  currency_code: string | null;
  timezone: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
};

const CUSTOMER_SELECT = `
  id,
  code,
  name,
  legal_name,
  display_name,
  tax_id,
  description,
  status,
  billing_email,
  billing_phone,
  address,
  country,
  currency_code,
  timezone,
  version,
  created_at,
  updated_at
`;

function mapRow(row: CustomerRow): SaaSCustomerRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    legalName: row.legal_name,
    displayName: row.display_name,
    taxId: row.tax_id,
    description: row.description,
    status: row.status,
    billingEmail: row.billing_email,
    billingPhone: row.billing_phone,
    address: row.address,
    country: row.country,
    currencyCode: row.currency_code,
    timezone: row.timezone,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createCustomer(
  input: CreateSaaSCustomerInput,
  executor?: PoolClient,
): Promise<SaaSCustomerRecord> {
  const query = executor ?? getPool();
  const result = await query.query<CustomerRow>(
    `INSERT INTO clients
       (id, code, name, legal_name, display_name, tax_id, description,
        status, billing_email, billing_phone, address, country,
        currency_code, timezone, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PROSPECT', $8, $9, $10, $11, $12, $13, 1)
     RETURNING ${CUSTOMER_SELECT}`,
    [
      randomUUID(),
      input.code,
      input.name,
      input.legalName ?? null,
      input.displayName ?? null,
      input.taxId ?? null,
      input.description ?? null,
      input.billingEmail ?? null,
      input.billingPhone ?? null,
      input.address ?? null,
      input.country ?? null,
      input.currencyCode ?? null,
      input.timezone ?? null,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(
  id: string,
  executor?: PoolClient,
): Promise<SaaSCustomerRecord | null> {
  const query = executor ?? getPool();
  const result = await query.query<CustomerRow>(
    `SELECT ${CUSTOMER_SELECT} FROM clients WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByCode(
  code: string,
  executor?: PoolClient,
): Promise<SaaSCustomerRecord | null> {
  const query = executor ?? getPool();
  const result = await query.query<CustomerRow>(
    `SELECT ${CUSTOMER_SELECT} FROM clients WHERE code = $1`,
    [code],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByBillingEmail(
  billingEmail: string,
  executor?: PoolClient,
): Promise<SaaSCustomerRecord | null> {
  const query = executor ?? getPool();
  const result = await query.query<CustomerRow>(
    `SELECT ${CUSTOMER_SELECT} FROM clients WHERE billing_email = $1`,
    [billingEmail],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export type ListSaaSCustomersParams = {
  filters: ListSaaSCustomerFilters;
  limit?: number;
  offset?: number;
  withTotal?: boolean;
};

export type ListSaaSCustomersResult = {
  records: SaaSCustomerRecord[];
  total: number | null;
};

async function listCustomers(
  params: ListSaaSCustomersParams,
): Promise<ListSaaSCustomersResult> {
  const query = getPool();
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (params.filters.status !== undefined) {
    values.push(params.filters.status);
    clauses.push(`status = $${values.length}`);
  }
  if (params.filters.q !== undefined) {
    values.push(`%${params.filters.q}%`);
    clauses.push(`(code ILIKE $${values.length} OR name ILIKE $${values.length})`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  if (params.withTotal) {
    const totalResult = await query.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM clients ${where}`,
      values,
    );
    const total = totalResult.rows[0]?.total ?? 0;
    const listParams = [
      ...values,
      params.limit ?? Number.MAX_SAFE_INTEGER,
      params.offset ?? 0,
    ];
    const result = await query.query<CustomerRow>(
      `SELECT ${CUSTOMER_SELECT} FROM clients ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${listParams.length - 1}
        OFFSET $${listParams.length}`,
      listParams,
    );
    return { records: result.rows.map(mapRow), total };
  }

  const result = await query.query<CustomerRow>(
    `SELECT ${CUSTOMER_SELECT} FROM clients ${where}
      ORDER BY created_at DESC, id DESC`,
    values,
  );
  return { records: result.rows.map(mapRow), total: null };
}

type SettableFields = Omit<UpdateSaaSCustomerInput, 'expectedVersion'>;

const SETTABLE_COLUMNS: ReadonlyArray<
  [keyof SettableFields, string]
> = [
  ['name', 'name'],
  ['legalName', 'legal_name'],
  ['displayName', 'display_name'],
  ['taxId', 'tax_id'],
  ['description', 'description'],
  ['billingEmail', 'billing_email'],
  ['billingPhone', 'billing_phone'],
  ['address', 'address'],
  ['country', 'country'],
  ['currencyCode', 'currency_code'],
  ['timezone', 'timezone'],
];

/**
 * Applies registry-field updates under an optimistic version check.
 * Returns the updated row, or null when the row no longer matches
 * `expectedVersion` (concurrent modification) or does not exist.
 */
async function updateCustomerWithVersion(
  id: string,
  input: UpdateSaaSCustomerInput,
  executor?: PoolClient,
): Promise<SaaSCustomerRecord | null> {
  const query = executor ?? getPool();

  const sets: string[] = [];
  const values: unknown[] = [];

  for (const [field, column] of SETTABLE_COLUMNS) {
    const value = input[field];
    if (value !== undefined) {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
  }

  values.push(input.expectedVersion, id);
  sets.push(`version = version + 1`, `updated_at = NOW()`);

  const result = await query.query<CustomerRow>(
    `UPDATE clients
        SET ${sets.join(', ')}
      WHERE id = $${values.length}
        AND version = $${values.length - 1}
      RETURNING ${CUSTOMER_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Applies one lifecycle transition under an optimistic version check.
 * The transition TABLE is validated by the service layer; this is the
 * persistence half (status + version bump in one statement).
 */
async function transitionStatusWithVersion(
  id: string,
  toStatus: SaaSCustomerStorageStatus,
  expectedVersion: number,
  executor?: PoolClient,
): Promise<SaaSCustomerRecord | null> {
  const query = executor ?? getPool();
  const result = await query.query<CustomerRow>(
    `UPDATE clients
        SET status = $1, version = version + 1, updated_at = NOW()
      WHERE id = $2
        AND version = $3
      RETURNING ${CUSTOMER_SELECT}`,
    [toStatus, id, expectedVersion],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Row lock for the subscription-lifecycle re-projection transaction
 * (frozen §7.2/§11.2 rule 4: customer status is a server-side projection
 * of the customer's best subscriptions, written only by the subscription
 * lifecycle service).
 */
async function lockById(
  id: string,
  executor?: PoolClient,
): Promise<SaaSCustomerRecord | null> {
  const query = executor ?? getPool();
  const result = await query.query<CustomerRow>(
    `SELECT ${CUSTOMER_SELECT} FROM clients WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Server-driven projection write (frozen §7.2): status + version bump with
 * NO expectedVersion guard — the caller MUST hold the row lock from
 * `lockById`. Used exclusively by the subscription lifecycle service; the
 * console PATCH path keeps using `updateCustomerWithVersion` (OCC).
 */
async function setProjectedStatus(
  id: string,
  status: SaaSCustomerStorageStatus,
  executor?: PoolClient,
): Promise<SaaSCustomerRecord | null> {
  const query = executor ?? getPool();
  const result = await query.query<CustomerRow>(
    `UPDATE clients SET status = $1, version = version + 1, updated_at = NOW()
      WHERE id = $2
      RETURNING ${CUSTOMER_SELECT}`,
    [status, id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const platformCustomerRepository = {
  createCustomer,
  findById,
  findByCode,
  findByBillingEmail,
  listCustomers,
  updateCustomerWithVersion,
  transitionStatusWithVersion,
  lockById,
  setProjectedStatus,
};
