import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanWorkerContextRecord,
  HandymanWorkerContextStatus,
  NewHandymanWorkerContextRecord,
} from './handyman-worker-context.types';

/**
 * CR-HM-04 PART 02 — Handyman worker context repository (executor-first
 * convention). Bounded: INSERT, reads, status transitions only.
 */

type Row = {
  id: string;
  client_id: string;
  handyman_provider_context_id: string;
  workforce_profile_id: string;
  status: HandymanWorkerContextStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const CONTEXT_SELECT = `
  SELECT id, client_id, handyman_provider_context_id, workforce_profile_id,
         status, created_by_user_id, created_at, updated_at
    FROM handyman_worker_contexts`;

function map(row: Row): HandymanWorkerContextRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanProviderContextId: row.handyman_provider_context_id,
    workforceProfileId: row.workforce_profile_id,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertContext(
  executor: Pick<PoolClient, 'query'> = getPool(),
  record: NewHandymanWorkerContextRecord,
  createdByUserId: string,
): Promise<HandymanWorkerContextRecord> {
  const result = await executor.query<Row>(
    `INSERT INTO handyman_worker_contexts (
       id, client_id, handyman_provider_context_id, workforce_profile_id,
       created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, client_id, handyman_provider_context_id,
               workforce_profile_id, status, created_by_user_id,
               created_at, updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.handymanProviderContextId,
      record.workforceProfileId,
      createdByUserId,
    ],
  );
  return map(result.rows[0]);
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanWorkerContextRecord | null> {
  const result = await executor.query<Row>(
    `${CONTEXT_SELECT} WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

async function findByProviderAndProfile(
  executor: Pick<PoolClient, 'query'> = getPool(),
  providerContextId: string,
  workforceProfileId: string,
): Promise<HandymanWorkerContextRecord | null> {
  const result = await executor.query<Row>(
    `${CONTEXT_SELECT}
      WHERE handyman_provider_context_id = $1 AND workforce_profile_id = $2`,
    [providerContextId, workforceProfileId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** FOR UPDATE lock for atomic status transitions inside a transaction. */
async function lockById(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanWorkerContextRecord | null> {
  const result = await executor.query<Row>(
    `${CONTEXT_SELECT} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

async function updateStatus(
  executor: Pick<PoolClient, 'query'>,
  id: string,
  status: HandymanWorkerContextStatus,
): Promise<HandymanWorkerContextRecord | null> {
  const result = await executor.query<Row>(
    `UPDATE handyman_worker_contexts
        SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, client_id, handyman_provider_context_id,
                workforce_profile_id, status, created_by_user_id,
                created_at, updated_at`,
    [id, status],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

export const handymanWorkerContextRepository = {
  insertContext,
  findById,
  findByProviderAndProfile,
  lockById,
  updateStatus,
};
