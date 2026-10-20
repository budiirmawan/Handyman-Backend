import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  TenantImportBatchRecord,
  TenantImportBatchStatus,
  TenantImportRowRecord,
  TenantImportRowStatus,
} from './tenant-import.types';

const BATCH_SELECT = `id, client_id AS "clientId", idempotency_key AS "idempotencyKey",
  source_name AS "sourceName", source_checksum AS "sourceChecksum", status,
  total_rows AS "totalRows", valid_rows AS "validRows", invalid_rows AS "invalidRows",
  committed_rows AS "committedRows", skipped_rows AS "skippedRows",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt", validated_at AS "validatedAt", confirmed_at AS "confirmedAt",
  committed_at AS "committedAt", aborted_at AS "abortedAt", updated_at AS "updatedAt"`;

const ROW_SELECT = `id, batch_id AS "batchId", client_id AS "clientId",
  row_number AS "rowNumber", row_key AS "rowKey", payload, status,
  error_code AS "errorCode", error_message AS "errorMessage", outcome,
  tenant_company_id AS "tenantCompanyId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export type NewTenantImportBatch = {
  clientId: string;
  idempotencyKey: string | null;
  sourceName: string;
  sourceChecksum: string;
  totalRows: number;
  createdByUserId: string;
};

export type NewTenantImportRow = {
  batchId: string;
  clientId: string;
  rowNumber: number;
  rowKey: string;
  payload: unknown;
  status: TenantImportRowStatus;
  errorCode: string | null;
  errorMessage: string | null;
  outcome?: Record<string, unknown>;
  tenantCompanyId: string | null;
};

export type TenantImportBatchPatch = {
  status?: TenantImportBatchStatus;
  validRows?: number;
  invalidRows?: number;
  committedRows?: number;
  skippedRows?: number;
  validatedAt?: Date;
  confirmedAt?: Date;
  committedAt?: Date;
  abortedAt?: Date;
};

export type TenantImportRowPatch = {
  status?: TenantImportRowStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  outcome?: Record<string, unknown>;
  tenantCompanyId?: string | null;
};

async function createBatch(input: NewTenantImportBatch): Promise<TenantImportBatchRecord> {
  const result = await getPool().query<TenantImportBatchRecord>(
    `INSERT INTO tenant_import_batches
       (id, client_id, idempotency_key, source_name, source_checksum, status,
        total_rows, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,'UPLOADED',$6,$7)
     RETURNING ${BATCH_SELECT}`,
    [randomUUID(), input.clientId, input.idempotencyKey, input.sourceName,
      input.sourceChecksum, input.totalRows, input.createdByUserId],
  );
  return result.rows[0];
}

async function findBatchById(
  clientId: string,
  batchId: string,
): Promise<TenantImportBatchRecord | null> {
  const result = await getPool().query<TenantImportBatchRecord>(
    `SELECT ${BATCH_SELECT} FROM tenant_import_batches
      WHERE id = $1 AND client_id = $2`,
    [batchId, clientId],
  );
  return result.rows[0] ?? null;
}

async function findBatchByIdempotencyKey(
  clientId: string,
  idempotencyKey: string,
): Promise<TenantImportBatchRecord | null> {
  const result = await getPool().query<TenantImportBatchRecord>(
    `SELECT ${BATCH_SELECT} FROM tenant_import_batches
      WHERE client_id = $1 AND idempotency_key = $2`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function listBatches(
  clientId: string,
  limit: number,
  offset: number,
): Promise<{ items: TenantImportBatchRecord[]; total: number }> {
  const counted = await getPool().query<{ total: number }>(
    'SELECT count(*)::int AS total FROM tenant_import_batches WHERE client_id = $1',
    [clientId],
  );
  const result = await getPool().query<TenantImportBatchRecord>(
    `SELECT ${BATCH_SELECT} FROM tenant_import_batches
      WHERE client_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [clientId, limit, offset],
  );
  return { items: result.rows, total: counted.rows[0]?.total ?? 0 };
}

async function updateBatch(
  id: string,
  patch: TenantImportBatchPatch,
): Promise<TenantImportBatchRecord | null> {
  const columns: [keyof TenantImportBatchPatch, string][] = [
    ['status', 'status'],
    ['validRows', 'valid_rows'],
    ['invalidRows', 'invalid_rows'],
    ['committedRows', 'committed_rows'],
    ['skippedRows', 'skipped_rows'],
    ['validatedAt', 'validated_at'],
    ['confirmedAt', 'confirmed_at'],
    ['committedAt', 'committed_at'],
    ['abortedAt', 'aborted_at'],
  ];
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of columns) {
    if (patch[key] !== undefined) {
      values.push(patch[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) return findBatchByIdUnscoped(id);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<TenantImportBatchRecord>(
    `UPDATE tenant_import_batches SET ${sets.join(', ')}
      WHERE id = $${values.length} RETURNING ${BATCH_SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

async function findBatchByIdUnscoped(
  id: string,
): Promise<TenantImportBatchRecord | null> {
  const result = await getPool().query<TenantImportBatchRecord>(
    `SELECT ${BATCH_SELECT} FROM tenant_import_batches WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function insertRows(rows: NewTenantImportRow[]): Promise<void> {
  for (const row of rows) {
    await getPool().query(
      `INSERT INTO tenant_import_rows
         (id, batch_id, client_id, row_number, row_key, payload, status,
          error_code, error_message, outcome, tenant_company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [randomUUID(), row.batchId, row.clientId, row.rowNumber, row.rowKey,
        JSON.stringify(row.payload), row.status, row.errorCode,
        row.errorMessage, JSON.stringify(row.outcome ?? {}), row.tenantCompanyId],
    );
  }
}

async function updateRow(
  id: string,
  patch: TenantImportRowPatch,
): Promise<TenantImportRowRecord | null> {
  const columns: [keyof TenantImportRowPatch, string][] = [
    ['status', 'status'],
    ['errorCode', 'error_code'],
    ['errorMessage', 'error_message'],
    ['outcome', 'outcome'],
    ['tenantCompanyId', 'tenant_company_id'],
  ];
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of columns) {
    if (patch[key] !== undefined) {
      values.push(key === 'outcome' ? JSON.stringify(patch[key]) : patch[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) return findRowById(id);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<TenantImportRowRecord>(
    `UPDATE tenant_import_rows SET ${sets.join(', ')}
      WHERE id = $${values.length} RETURNING ${ROW_SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

async function findRowById(id: string): Promise<TenantImportRowRecord | null> {
  const result = await getPool().query<TenantImportRowRecord>(
    `SELECT ${ROW_SELECT} FROM tenant_import_rows WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function listRows(
  batchId: string,
  filters: { status?: TenantImportRowStatus },
  limit: number,
  offset: number,
): Promise<{ items: TenantImportRowRecord[]; total: number }> {
  const clauses = ['batch_id = $1'];
  const values: unknown[] = [batchId];
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }
  const where = clauses.join(' AND ');
  const counted = await getPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM tenant_import_rows WHERE ${where}`,
    values,
  );
  const pageValues = [...values, limit, offset];
  const result = await getPool().query<TenantImportRowRecord>(
    `SELECT ${ROW_SELECT} FROM tenant_import_rows WHERE ${where}
      ORDER BY row_number ASC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues,
  );
  return { items: result.rows, total: counted.rows[0]?.total ?? 0 };
}

async function listAllRows(batchId: string): Promise<TenantImportRowRecord[]> {
  const result = await getPool().query<TenantImportRowRecord>(
    `SELECT ${ROW_SELECT} FROM tenant_import_rows WHERE batch_id = $1
      ORDER BY row_number ASC`,
    [batchId],
  );
  return result.rows;
}

export const tenantImportRepository = {
  createBatch,
  findBatchById,
  findBatchByIdUnscoped,
  findBatchByIdempotencyKey,
  insertRows,
  listBatches,
  listAllRows,
  listRows,
  updateBatch,
  updateRow,
};
