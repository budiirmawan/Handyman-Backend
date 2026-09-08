import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  InventoryWarehouseRecord,
  InventoryWarehouseStatus,
  NewInventoryWarehouse,
  UpdateInventoryWarehouseInput,
} from './inventory-warehouse.types';

type WarehouseRow = {
  id: string;
  clientId: string;
  buildingId: string;
  functionalLocationId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: InventoryWarehouseStatus;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  functional_location_id AS "functionalLocationId",
  code,
  name,
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function map(row: WarehouseRow): InventoryWarehouseRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    functionalLocationId: row.functionalLocationId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(input: NewInventoryWarehouse): Promise<InventoryWarehouseRecord> {
  const result = await getPool().query<WarehouseRow>(
    `INSERT INTO inventory_warehouses
       (id, client_id, building_id, functional_location_id, code, name, description, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.functionalLocationId,
      input.code,
      input.name,
      input.description,
      input.status,
    ],
  );
  return map(result.rows[0]);
}

async function findById(id: string): Promise<InventoryWarehouseRecord | null> {
  const res = await getPool().query<WarehouseRow>(
    `SELECT ${SELECT} FROM inventory_warehouses WHERE id=$1`,
    [id],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByCodeForBuilding(
  buildingId: string,
  code: string,
): Promise<InventoryWarehouseRecord | null> {
  const res = await getPool().query<WarehouseRow>(
    `SELECT ${SELECT} FROM inventory_warehouses WHERE building_id=$1 AND code=$2`,
    [buildingId, code],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByIdWithLocation(id: string): Promise<any> {
  const res = await getPool().query(
    `SELECT
       w.id,
       w.client_id AS "clientId",
       w.building_id AS "buildingId",
       w.functional_location_id AS "functionalLocationId",
       w.code,
       w.name,
       w.description,
       w.status,
       w.created_at AS "createdAt",
       w.updated_at AS "updatedAt",
       fl.id AS "flId",
       fl.code AS "flCode",
       fl.name AS "flName",
       fl.status AS "flStatus"
     FROM inventory_warehouses w
     LEFT JOIN functional_locations fl ON fl.id = w.functional_location_id
     WHERE w.id=$1`,
    [id],
  );
  return res.rows[0] ?? null;
}

async function listByBuilding(
  buildingId: string,
  filters: { status?: InventoryWarehouseStatus; search?: string; functionalLocationId?: string },
): Promise<InventoryWarehouseRecord[]> {
  const conditions: string[] = ['building_id=$1'];
  const values: unknown[] = [buildingId];
  let idx = 2;

  if (filters.status) {
    conditions.push(`status=$${idx++}`);
    values.push(filters.status);
  }
  if (filters.functionalLocationId) {
    conditions.push(`functional_location_id=$${idx++}`);
    values.push(filters.functionalLocationId);
  }
  if (filters.search) {
    conditions.push(`(code ILIKE $${idx} OR name ILIKE $${idx})`);
    values.push(`%${filters.search}%`);
    idx++;
  }

  const where = conditions.join(' AND ');
  const res = await getPool().query<WarehouseRow>(
    `SELECT ${SELECT} FROM inventory_warehouses WHERE ${where} ORDER BY code ASC`,
    values,
  );
  return res.rows.map(map);
}

async function listByClient(
  clientId: string,
  filters: { buildingId?: string; status?: InventoryWarehouseStatus; search?: string },
): Promise<InventoryWarehouseRecord[]> {
  const conditions: string[] = ['client_id=$1'];
  const values: unknown[] = [clientId];
  let idx = 2;

  if (filters.buildingId) {
    conditions.push(`building_id=$${idx++}`);
    values.push(filters.buildingId);
  }
  if (filters.status) {
    conditions.push(`status=$${idx++}`);
    values.push(filters.status);
  }
  if (filters.search) {
    conditions.push(`(code ILIKE $${idx} OR name ILIKE $${idx})`);
    values.push(`%${filters.search}%`);
    idx++;
  }

  const where = conditions.join(' AND ');
  const res = await getPool().query<WarehouseRow>(
    `SELECT ${SELECT} FROM inventory_warehouses WHERE ${where} ORDER BY code ASC`,
    values,
  );
  return res.rows.map(map);
}

async function update(
  id: string,
  input: UpdateInventoryWarehouseInput,
): Promise<InventoryWarehouseRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) {
    sets.push(`name=$${idx++}`);
    values.push(input.name);
  }
  if (input.functionalLocationId !== undefined) {
    sets.push(`functional_location_id=$${idx++}`);
    values.push(input.functionalLocationId);
  }
  if (input.description !== undefined) {
    sets.push(`description=$${idx++}`);
    values.push(input.description);
  }
  if (input.status !== undefined) {
    sets.push(`status=$${idx++}`);
    values.push(input.status);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  sets.push('updated_at=NOW()');
  values.push(id);

  const res = await getPool().query<WarehouseRow>(
    `UPDATE inventory_warehouses SET ${sets.join(',')} WHERE id=$${idx} RETURNING ${SELECT}`,
    values,
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

export const inventoryWarehouseRepository = {
  create,
  findById,
  findByCodeForBuilding,
  findByIdWithLocation,
  listByBuilding,
  listByClient,
  update,
};
