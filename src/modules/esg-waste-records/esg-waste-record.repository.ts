import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  EsgDisposalMethod,
  EsgWasteRecord,
  EsgWasteRecordFilters,
  EsgWasteSourceType,
  EsgWasteStatus,
  EsgWasteType,
  NewEsgWasteRecord,
  UpdateEsgWasteRecordInput,
} from './esg-waste-record.types';

type Row = {
  id: string;
  clientId: string;
  buildingId: string;
  functionalLocationId: string | null;
  wasteType: EsgWasteType;
  disposalMethod: EsgDisposalMethod;
  quantity: string;
  uomId: string;
  periodDate: Date;
  sourceType: EsgWasteSourceType;
  vendorId: string | null;
  notes: string | null;
  status: EsgWasteStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  functional_location_id AS "functionalLocationId",
  waste_type AS "wasteType",
  disposal_method AS "disposalMethod",
  quantity::text AS "quantity",
  uom_id AS "uomId",
  period_date AS "periodDate",
  source_type AS "sourceType",
  vendor_id AS "vendorId",
  notes,
  status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function map(row: Row): EsgWasteRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    functionalLocationId: row.functionalLocationId,
    wasteType: row.wasteType,
    disposalMethod: row.disposalMethod,
    quantity: row.quantity,
    uomId: row.uomId,
    periodDate: row.periodDate,
    sourceType: row.sourceType,
    vendorId: row.vendorId,
    notes: row.notes,
    status: row.status,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function insert(
  executor: Pick<PoolClient, 'query'> = getPool(),
  rec: NewEsgWasteRecord,
): Promise<EsgWasteRecord> {
  const result = await executor.query<Row>(
    `INSERT INTO esg_waste_records
       (id, client_id, building_id, functional_location_id, waste_type, disposal_method, quantity, uom_id, period_date, source_type, vendor_id, notes, status, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ACTIVE',$13)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      rec.clientId,
      rec.buildingId,
      rec.functionalLocationId,
      rec.wasteType,
      rec.disposalMethod,
      rec.quantity,
      rec.uomId,
      rec.periodDate,
      rec.sourceType,
      rec.vendorId,
      rec.notes,
      rec.createdByUserId,
    ],
  );
  return map(result.rows[0]);
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<EsgWasteRecord | null> {
  const res = await executor.query<Row>(
    `SELECT ${SELECT} FROM esg_waste_records WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  return row ? map(row) : null;
}

async function listScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  accessibleBuildingIds: string[],
  filters: EsgWasteRecordFilters,
): Promise<EsgWasteRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  conditions.push(`building_id = ANY($${idx++})`);
  values.push(accessibleBuildingIds);

  if (filters.clientId) {
    conditions.push(`client_id = $${idx++}`);
    values.push(filters.clientId);
  }
  if (filters.buildingId) {
    conditions.push(`building_id = $${idx++}`);
    values.push(filters.buildingId);
  }
  if (filters.functionalLocationId) {
    conditions.push(`functional_location_id = $${idx++}`);
    values.push(filters.functionalLocationId);
  }
  if (filters.wasteType) {
    conditions.push(`waste_type = $${idx++}`);
    values.push(filters.wasteType);
  }
  if (filters.disposalMethod) {
    conditions.push(`disposal_method = $${idx++}`);
    values.push(filters.disposalMethod);
  }
  if (filters.sourceType) {
    conditions.push(`source_type = $${idx++}`);
    values.push(filters.sourceType);
  }
  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    values.push(filters.status);
  }
  if (filters.uomId) {
    conditions.push(`uom_id = $${idx++}`);
    values.push(filters.uomId);
  }
  if (filters.vendorId) {
    conditions.push(`vendor_id = $${idx++}`);
    values.push(filters.vendorId);
  }
  if (filters.dateFrom) {
    conditions.push(`period_date >= $${idx++}::date`);
    values.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    conditions.push(`period_date <= $${idx++}::date`);
    values.push(filters.dateTo);
  }
  if (filters.search) {
    const search = `%${filters.search.trim()}%`;
    conditions.push(`(notes ILIKE $${idx} OR waste_type ILIKE $${idx} OR disposal_method ILIKE $${idx})`);
    values.push(search);
    idx++;
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const res = await executor.query<Row>(
    `SELECT ${SELECT} FROM esg_waste_records ${where} ORDER BY period_date DESC, created_at DESC`,
    values,
  );
  return res.rows.map(map);
}

async function update(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
  input: {
    functionalLocationId?: string | null;
    wasteType?: EsgWasteType;
    disposalMethod?: EsgDisposalMethod;
    quantity?: number;
    uomId?: string;
    periodDate?: Date;
    sourceType?: EsgWasteSourceType;
    vendorId?: string | null;
    notes?: string | null;
  },
): Promise<EsgWasteRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.functionalLocationId !== undefined) {
    sets.push(`functional_location_id = $${idx++}`);
    values.push(input.functionalLocationId);
  }
  if (input.wasteType !== undefined) {
    sets.push(`waste_type = $${idx++}`);
    values.push(input.wasteType);
  }
  if (input.disposalMethod !== undefined) {
    sets.push(`disposal_method = $${idx++}`);
    values.push(input.disposalMethod);
  }
  if (input.quantity !== undefined) {
    sets.push(`quantity = $${idx++}`);
    values.push(input.quantity);
  }
  if (input.uomId !== undefined) {
    sets.push(`uom_id = $${idx++}`);
    values.push(input.uomId);
  }
  if (input.periodDate !== undefined) {
    sets.push(`period_date = $${idx++}`);
    values.push(input.periodDate);
  }
  if (input.sourceType !== undefined) {
    sets.push(`source_type = $${idx++}`);
    values.push(input.sourceType);
  }
  if (input.vendorId !== undefined) {
    sets.push(`vendor_id = $${idx++}`);
    values.push(input.vendorId);
  }
  if (input.notes !== undefined) {
    sets.push(`notes = $${idx++}`);
    values.push(input.notes);
  }

  if (sets.length === 0) {
    return findById(executor, id);
  }

  sets.push(`updated_at = NOW()`);
  values.push(id);

  const res = await executor.query<Row>(
    `UPDATE esg_waste_records SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${SELECT}`,
    values,
  );
  const row = res.rows[0];
  return row ? map(row) : null;
}

async function deactivate(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<EsgWasteRecord | null> {
  const res = await executor.query<Row>(
    `UPDATE esg_waste_records SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1 AND status = 'ACTIVE' RETURNING ${SELECT}`,
    [id],
  );
  const row = res.rows[0];
  return row ? map(row) : null;
}

export const esgWasteRecordRepository = {
  insert,
  findById,
  listScoped,
  update,
  deactivate,
};
