import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  SaasProvisioningRunRecord,
  SaasProvisioningRunStatus,
  SaasProvisioningStep,
} from './platform-provisioning.types';

type Executor = Pick<PoolClient, 'query'> | ReturnType<typeof getPool>;

function executor(q?: Executor): Executor {
  return q ?? getPool();
}

type RunRow = {
  id: string;
  customerId: string;
  status: SaasProvisioningRunStatus;
  attempt: number;
  steps: SaasProvisioningStep[];
  lastError: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const RUN_SELECT = `
  id,
  customer_id AS "customerId",
  status,
  attempt,
  steps,
  last_error AS "lastError",
  completed_at AS "completedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRun(row: RunRow): SaasProvisioningRunRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    status: row.status,
    attempt: row.attempt,
    steps: Array.isArray(row.steps) ? row.steps : [],
    lastError: row.lastError,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(
  input: { customerId: string; steps?: SaasProvisioningStep[] },
  q?: Executor,
): Promise<SaasProvisioningRunRecord> {
  const result = await executor(q).query<RunRow>(
    `INSERT INTO saas_provisioning_runs (id, customer_id, status, attempt, steps)
     VALUES ($1, $2, 'RUNNING', 1, $3)
     RETURNING ${RUN_SELECT}`,
    [randomUUID(), input.customerId, JSON.stringify(input.steps ?? [])],
  );
  return mapRun(result.rows[0]);
}

async function findById(id: string, q?: Executor): Promise<SaasProvisioningRunRecord | null> {
  const result = await executor(q).query<RunRow>(
    `SELECT ${RUN_SELECT} FROM saas_provisioning_runs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRun(row) : null;
}

async function findLatestByCustomer(
  customerId: string,
  q?: Executor,
): Promise<SaasProvisioningRunRecord | null> {
  const result = await executor(q).query<RunRow>(
    `SELECT ${RUN_SELECT} FROM saas_provisioning_runs
      WHERE customer_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [customerId],
  );
  const row = result.rows[0];
  return row ? mapRun(row) : null;
}

async function findLatestCompletedByCustomer(
  customerId: string,
  q?: Executor,
): Promise<SaasProvisioningRunRecord | null> {
  const result = await executor(q).query<RunRow>(
    `SELECT ${RUN_SELECT} FROM saas_provisioning_runs
      WHERE customer_id = $1 AND status = 'COMPLETED'
      ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT 1`,
    [customerId],
  );
  const row = result.rows[0];
  return row ? mapRun(row) : null;
}

async function appendSteps(
  id: string,
  steps: SaasProvisioningStep[],
  q?: Executor,
): Promise<SaasProvisioningRunRecord | null> {
  const result = await executor(q).query<RunRow>(
    `UPDATE saas_provisioning_runs
        SET steps = steps || $2::jsonb,
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${RUN_SELECT}`,
    [id, JSON.stringify(steps)],
  );
  const row = result.rows[0];
  return row ? mapRun(row) : null;
}

async function complete(id: string, q?: Executor): Promise<SaasProvisioningRunRecord | null> {
  const result = await executor(q).query<RunRow>(
    `UPDATE saas_provisioning_runs
        SET status = 'COMPLETED',
            completed_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
      WHERE id = $1 AND status = 'RUNNING'
      RETURNING ${RUN_SELECT}`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRun(row) : null;
}

async function fail(
  id: string,
  errorMessage: string,
  q?: Executor,
): Promise<SaasProvisioningRunRecord | null> {
  const truncated = errorMessage.length > 2000 ? `${errorMessage.slice(0, 2000)}…` : errorMessage;
  const result = await executor(q).query<RunRow>(
    `UPDATE saas_provisioning_runs
        SET status = 'FAILED',
            last_error = $2,
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${RUN_SELECT}`,
    [id, truncated],
  );
  const row = result.rows[0];
  return row ? mapRun(row) : null;
}

export const saasProvisioningRunRepository = {
  appendSteps,
  complete,
  create,
  fail,
  findById,
  findLatestByCustomer,
  findLatestCompletedByCustomer,
};
