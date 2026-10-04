import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanProviderContextRecord,
  HandymanProviderContextStatus,
  NewHandymanProviderContextRecord,
} from './handyman-provider-context.types';

/**
 * CR-HM-04 PART 01 — Handyman provider context repository
 * (executor-first convention: shared pool by default; transaction
 * executor as the FIRST argument). Bounded: INSERT, reads, status
 * transitions only — rows are never deleted (F8: INACTIVE = historical).
 */

type Row = {
  id: string;
  client_id: string;
  vendor_id: string;
  status: HandymanProviderContextStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const CONTEXT_SELECT = `
  SELECT id, client_id, vendor_id, status, created_by_user_id,
         created_at, updated_at
    FROM handyman_provider_contexts`;

function map(row: Row): HandymanProviderContextRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    vendorId: row.vendor_id,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertContext(
  executor: Pick<PoolClient, 'query'> = getPool(),
  record: NewHandymanProviderContextRecord,
  createdByUserId: string,
): Promise<HandymanProviderContextRecord> {
  const result = await executor.query<Row>(
    `INSERT INTO handyman_provider_contexts (
       id, client_id, vendor_id, created_by_user_id
     ) VALUES ($1, $2, $3, $4)
     RETURNING id, client_id, vendor_id, status, created_by_user_id,
               created_at, updated_at`,
    [randomUUID(), record.clientId, record.vendorId, createdByUserId],
  );
  return map(result.rows[0]);
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanProviderContextRecord | null> {
  const result = await executor.query<Row>(
    `${CONTEXT_SELECT} WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

async function findByVendor(
  executor: Pick<PoolClient, 'query'> = getPool(),
  vendorId: string,
): Promise<HandymanProviderContextRecord | null> {
  const result = await executor.query<Row>(
    `${CONTEXT_SELECT} WHERE vendor_id = $1`,
    [vendorId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** FOR UPDATE lock for atomic status transitions inside a transaction. */
async function lockById(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanProviderContextRecord | null> {
  const result = await executor.query<Row>(
    `${CONTEXT_SELECT} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

async function updateStatus(
  executor: Pick<PoolClient, 'query'>,
  id: string,
  status: HandymanProviderContextStatus,
): Promise<HandymanProviderContextRecord | null> {
  const result = await executor.query<Row>(
    `UPDATE handyman_provider_contexts
        SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, client_id, vendor_id, status, created_by_user_id,
                created_at, updated_at`,
    [id, status],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

async function listActiveByClient(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  providerContextId?: string,
): Promise<HandymanProviderContextRecord[]> {
  const conditions = [`client_id = $1`, `status = 'ACTIVE'`];
  const values: unknown[] = [clientId];
  if (providerContextId !== undefined) {
    conditions.push(`id = $2`);
    values.push(providerContextId);
  }
  const result = await executor.query<Row>(
    `${CONTEXT_SELECT}
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ASC, id ASC`,
    values,
  );
  return result.rows.map(map);
}

export const handymanProviderContextRepository = {
  insertContext,
  findById,
  findByVendor,
  lockById,
  updateStatus,
  listActiveByClient,
};
