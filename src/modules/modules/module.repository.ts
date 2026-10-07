import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  ModuleRecord,
  ModuleStatus,
  NewModule,
} from './module.types';

type ModuleRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: ModuleStatus;
  createdAt: Date;
  updatedAt: Date;
};

const MODULE_SELECT = `
  id,
  code,
  name,
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapModuleRow(row: ModuleRow): ModuleRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createModule(input: NewModule): Promise<ModuleRecord> {
  const result = await getPool().query<ModuleRow>(
    `INSERT INTO modules (id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${MODULE_SELECT}`,
    [randomUUID(), input.code, input.name, input.description, input.status],
  );

  return mapModuleRow(result.rows[0]);
}

async function findById(id: string): Promise<ModuleRecord | null> {
  const result = await getPool().query<ModuleRow>(
    `SELECT ${MODULE_SELECT} FROM modules WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapModuleRow(row) : null;
}

async function findByCode(
  code: string,
  q?: Pick<import('pg').PoolClient, 'query'>,
): Promise<ModuleRecord | null> {
  const result = await (q ?? getPool()).query<ModuleRow>(
    `SELECT ${MODULE_SELECT} FROM modules WHERE code = $1`,
    [code],
  );

  const row = result.rows[0];
  return row ? mapModuleRow(row) : null;
}

async function listModules(): Promise<ModuleRecord[]> {
  const result = await getPool().query<ModuleRow>(
    `SELECT ${MODULE_SELECT} FROM modules ORDER BY code ASC`,
  );

  return result.rows.map(mapModuleRow);
}

async function updateStatus(
  id: string,
  status: ModuleStatus,
): Promise<ModuleRecord | null> {
  const result = await getPool().query<ModuleRow>(
    `UPDATE modules SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${MODULE_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapModuleRow(row) : null;
}

export const moduleRepository = {
  createModule,
  findByCode,
  findById,
  listModules,
  updateStatus,
};
