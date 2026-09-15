import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  BreakdownBindingRecord,
  BreakdownBindingStatus,
} from './breakdown-binding.types';

/**
 * BE-10F — Breakdown / Corrective Binding repository.
 *
 * Holds breakdown event records and their corrective Work Order links. The
 * Work Order itself is created and driven exclusively through the BE-08
 * service — this repository never writes Work Order data, only the
 * reference.
 */

type BreakdownBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  asset_id: string;
  functional_location_id: string | null;
  work_order_id: string | null;
  category: string;
  description: string;
  reported_by_user_id: string;
  reported_at: Date;
  status: BreakdownBindingStatus;
  created_at: Date;
  updated_at: Date;
};

/** The linked corrective Work Order's authoritative BE-08 status. */
export type CorrectiveWorkOrderRow = {
  work_order_id: string;
  work_order_number: string;
  title: string;
  status: string;
};

function mapRow(row: BreakdownBindingRow): BreakdownBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    assetId: row.asset_id,
    functionalLocationId: row.functional_location_id,
    workOrderId: row.work_order_id,
    category: row.category,
    description: row.description,
    reportedByUserId: row.reported_by_user_id,
    reportedAt: row.reported_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: {
    clientId: string;
    buildingId: string;
    assetId: string;
    functionalLocationId: string | null;
    category: string;
    description: string;
    reportedByUserId: string;
    reportedAt: Date;
  },
): Promise<BreakdownBindingRecord> {
  const result = await getPool().query<BreakdownBindingRow>(
    `INSERT INTO breakdown_bindings
       (id, client_id, building_id, asset_id, functional_location_id,
        category, description, reported_by_user_id, reported_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, client_id, building_id, asset_id, functional_location_id,
               work_order_id, category, description, reported_by_user_id,
               reported_at, status, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.assetId,
      input.functionalLocationId,
      input.category,
      input.description,
      input.reportedByUserId,
      input.reportedAt,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<BreakdownBindingRecord | null> {
  const result = await getPool().query<BreakdownBindingRow>(
    `SELECT id, client_id, building_id, asset_id, functional_location_id,
            work_order_id, category, description, reported_by_user_id,
            reported_at, status, created_at, updated_at
     FROM breakdown_bindings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByAssetId(
  assetId: string,
): Promise<BreakdownBindingRecord[]> {
  const result = await getPool().query<BreakdownBindingRow>(
    `SELECT id, client_id, building_id, asset_id, functional_location_id,
            work_order_id, category, description, reported_by_user_id,
            reported_at, status, created_at, updated_at
     FROM breakdown_bindings
     WHERE asset_id = $1
     ORDER BY reported_at DESC`,
    [assetId],
  );
  return result.rows.map(mapRow);
}

export async function listByBuildingId(
  buildingId: string,
): Promise<BreakdownBindingRecord[]> {
  const result = await getPool().query<BreakdownBindingRow>(
    `SELECT id, client_id, building_id, asset_id, functional_location_id,
            work_order_id, category, description, reported_by_user_id,
            reported_at, status, created_at, updated_at
     FROM breakdown_bindings
     WHERE building_id = $1
     ORDER BY reported_at DESC`,
    [buildingId],
  );
  return result.rows.map(mapRow);
}

export async function linkWorkOrder(
  id: string,
  workOrderId: string,
): Promise<BreakdownBindingRecord | null> {
  const result = await getPool().query<BreakdownBindingRow>(
    `UPDATE breakdown_bindings
     SET work_order_id = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, client_id, building_id, asset_id, functional_location_id,
               work_order_id, category, description, reported_by_user_id,
               reported_at, status, created_at, updated_at`,
    [id, workOrderId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function updateStatus(
  id: string,
  status: BreakdownBindingStatus,
): Promise<BreakdownBindingRecord | null> {
  const result = await getPool().query<BreakdownBindingRow>(
    `UPDATE breakdown_bindings
     SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, client_id, building_id, asset_id, functional_location_id,
               work_order_id, category, description, reported_by_user_id,
               reported_at, status, created_at, updated_at`,
    [id, status],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * The corrective Work Order's current authoritative status, projected from
 * BE-08's own `work_orders` table — never stored on the breakdown.
 */
export async function findCorrectiveWorkOrder(
  workOrderId: string,
): Promise<CorrectiveWorkOrderRow | null> {
  const result = await getPool().query<CorrectiveWorkOrderRow>(
    `SELECT id AS work_order_id, work_order_number, title, status
     FROM work_orders WHERE id = $1`,
    [workOrderId],
  );
  return result.rows[0] ?? null;
}

export const breakdownBindingRepository = {
  create,
  findById,
  findCorrectiveWorkOrder,
  linkWorkOrder,
  listByAssetId,
  listByBuildingId,
  updateStatus,
};
