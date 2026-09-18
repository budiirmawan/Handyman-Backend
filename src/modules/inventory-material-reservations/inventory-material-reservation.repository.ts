import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanMaterialReservationDemand,
  HandymanMaterialReservationRecord,
  MaterialReservationDemand,
  MaterialReservationFilters,
  MaterialReservationRecord,
  MaterialReservationStatus,
  NewHandymanMaterialReservation,
  NewMaterialReservation,
} from './inventory-material-reservation.types';

type ReservationRow = {
  id: string;
  clientId: string;
  buildingId: string;
  materialRequestId: string;
  warehouseId: string;
  itemId: string;
  uomId: string | null;
  reservedQuantity: string | number;
  consumedQuantity: string | number;
  remainingQuantity: string | number;
  status: MaterialReservationStatus;
  createdByUserId: string;
  releasedByUserId: string | null;
  cancelledByUserId: string | null;
  consumedByUserId: string | null;
  notes: string | null;
  createdAt: Date;
  releasedAt: Date | null;
  cancelledAt: Date | null;
  consumedAt: Date | null;
  updatedAt: Date;
};

type DemandRow = {
  authorizedDemand: string;
  cumulativeIssued: string;
  activeReserved: string;
  remainingDemand: string;
  reservableDemand: string;
  reservationAllowed: boolean;
  issueAllowed: boolean;
};

type HandymanReservationRow = Omit<
  ReservationRow,
  'materialRequestId' | 'uomId'
> & {
  sourceType: 'HANDYMAN_MATERIAL_DEMAND';
  materialRequestId: null;
  handymanMaterialDemandId: string;
  uomId: string;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  terminalIdempotencyKey: string | null;
  terminalIdempotencyFingerprint: string | null;
};

type HandymanDemandRow = {
  authorizedDemand: string;
  cumulativeIssued: string;
  activeReserved: string;
  remainingDemand: string;
  reservableDemand: string;
  reservationAllowed: boolean;
  reservedIssueAllowed: boolean;
  unreservedIssueAllowed: boolean;
};

export type MaterialReservationBalanceRow = {
  id: string;
  quantityOnHand: string;
  reservedQuantity: string;
  availableQuantity: string;
};

const SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  material_request_id AS "materialRequestId",
  warehouse_id AS "warehouseId",
  item_id AS "itemId",
  uom_id AS "uomId",
  reserved_quantity AS "reservedQuantity",
  consumed_quantity AS "consumedQuantity",
  remaining_quantity AS "remainingQuantity",
  status,
  created_by_user_id AS "createdByUserId",
  released_by_user_id AS "releasedByUserId",
  cancelled_by_user_id AS "cancelledByUserId",
  consumed_by_user_id AS "consumedByUserId",
  notes,
  created_at AS "createdAt",
  released_at AS "releasedAt",
  cancelled_at AS "cancelledAt",
  consumed_at AS "consumedAt",
  updated_at AS "updatedAt"
`;

const HANDYMAN_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  source_type AS "sourceType",
  material_request_id AS "materialRequestId",
  handyman_material_demand_id AS "handymanMaterialDemandId",
  warehouse_id AS "warehouseId",
  item_id AS "itemId",
  uom_id AS "uomId",
  reserved_quantity AS "reservedQuantity",
  consumed_quantity AS "consumedQuantity",
  remaining_quantity AS "remainingQuantity",
  status,
  created_by_user_id AS "createdByUserId",
  released_by_user_id AS "releasedByUserId",
  cancelled_by_user_id AS "cancelledByUserId",
  consumed_by_user_id AS "consumedByUserId",
  idempotency_key AS "idempotencyKey",
  idempotency_fingerprint AS "idempotencyFingerprint",
  terminal_idempotency_key AS "terminalIdempotencyKey",
  terminal_idempotency_fingerprint AS "terminalIdempotencyFingerprint",
  notes,
  created_at AS "createdAt",
  released_at AS "releasedAt",
  cancelled_at AS "cancelledAt",
  consumed_at AS "consumedAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: ReservationRow): MaterialReservationRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    materialRequestId: row.materialRequestId,
    warehouseId: row.warehouseId,
    itemId: row.itemId,
    uomId: row.uomId ?? null,
    reservedQuantity:
      typeof row.reservedQuantity === 'number'
        ? row.reservedQuantity
        : Number(row.reservedQuantity),
    consumedQuantity:
      typeof row.consumedQuantity === 'number'
        ? row.consumedQuantity
        : Number(row.consumedQuantity),
    remainingQuantity:
      typeof row.remainingQuantity === 'number'
        ? row.remainingQuantity
        : Number(row.remainingQuantity),
    status: row.status,
    createdByUserId: row.createdByUserId,
    releasedByUserId: row.releasedByUserId ?? null,
    cancelledByUserId: row.cancelledByUserId ?? null,
    consumedByUserId: row.consumedByUserId ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt,
    releasedAt: row.releasedAt ?? null,
    cancelledAt: row.cancelledAt ?? null,
    consumedAt: row.consumedAt ?? null,
    updatedAt: row.updatedAt,
  };
}

function mapHandymanRow(
  row: HandymanReservationRow,
): HandymanMaterialReservationRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    sourceType: 'HANDYMAN_MATERIAL_DEMAND',
    materialRequestId: null,
    handymanMaterialDemandId: row.handymanMaterialDemandId,
    warehouseId: row.warehouseId,
    itemId: row.itemId,
    uomId: row.uomId,
    reservedQuantity:
      typeof row.reservedQuantity === 'number'
        ? row.reservedQuantity
        : Number(row.reservedQuantity),
    consumedQuantity:
      typeof row.consumedQuantity === 'number'
        ? row.consumedQuantity
        : Number(row.consumedQuantity),
    remainingQuantity:
      typeof row.remainingQuantity === 'number'
        ? row.remainingQuantity
        : Number(row.remainingQuantity),
    status: row.status,
    createdByUserId: row.createdByUserId,
    releasedByUserId: row.releasedByUserId ?? null,
    cancelledByUserId: row.cancelledByUserId ?? null,
    consumedByUserId: row.consumedByUserId ?? null,
    idempotencyKey: row.idempotencyKey,
    idempotencyFingerprint: row.idempotencyFingerprint,
    terminalIdempotencyKey: row.terminalIdempotencyKey ?? null,
    terminalIdempotencyFingerprint: row.terminalIdempotencyFingerprint ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt,
    releasedAt: row.releasedAt ?? null,
    cancelledAt: row.cancelledAt ?? null,
    consumedAt: row.consumedAt ?? null,
    updatedAt: row.updatedAt,
  };
}

async function createWithClient(
  client: PoolClient,
  input: NewMaterialReservation,
): Promise<MaterialReservationRecord> {
  const result = await client.query<ReservationRow>(
    `INSERT INTO inventory_material_reservations
       (id, client_id, building_id, source_type, material_request_id,
        warehouse_id, item_id, uom_id, reserved_quantity, status,
        created_by_user_id, notes)
     VALUES ($1, $2, $3, 'MATERIAL_REQUEST', $4, $5, $6, $7, $8, 'ACTIVE', $9, $10)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.materialRequestId,
      input.warehouseId,
      input.itemId,
      input.uomId,
      input.reservedQuantity,
      input.createdByUserId,
      input.notes,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<MaterialReservationRecord | null> {
  const result = await getPool().query<ReservationRow>(
    `SELECT ${SELECT}
     FROM inventory_material_reservations
     WHERE id = $1
       AND source_type = 'MATERIAL_REQUEST'`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Locks a reservation after its Material Request has been locked. */
async function findByIdForUpdate(
  client: PoolClient,
  id: string,
): Promise<MaterialReservationRecord | null> {
  const result = await client.query<ReservationRow>(
    `SELECT ${SELECT}
     FROM inventory_material_reservations
     WHERE id = $1
       AND source_type = 'MATERIAL_REQUEST'
     FOR UPDATE`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function findByIdWithDetails(
  id: string,
): Promise<Record<string, unknown> | null> {
  const result = await getPool().query(
    `SELECT
       r.id,
       r.client_id AS "clientId",
       r.building_id AS "buildingId",
       r.material_request_id AS "materialRequestId",
       r.warehouse_id AS "warehouseId",
       r.item_id AS "itemId",
       r.uom_id AS "uomId",
       r.reserved_quantity AS "reservedQuantity",
       r.consumed_quantity AS "consumedQuantity",
       r.remaining_quantity AS "remainingQuantity",
       r.status,
       r.created_by_user_id AS "createdByUserId",
       r.released_by_user_id AS "releasedByUserId",
       r.cancelled_by_user_id AS "cancelledByUserId",
       r.consumed_by_user_id AS "consumedByUserId",
       r.notes,
       r.created_at AS "createdAt",
       r.released_at AS "releasedAt",
       r.cancelled_at AS "cancelledAt",
       r.consumed_at AS "consumedAt",
       r.updated_at AS "updatedAt",
       mr.item_id AS "materialRequestItemId",
       mr.warehouse_id AS "materialRequestWarehouseId",
       mr.quantity AS "materialRequestQuantity",
       mr.approved_quantity AS "materialRequestApprovedQuantity",
       mr.status AS "materialRequestStatus",
       w.code AS "warehouseCode",
       w.name AS "warehouseName",
       w.building_id AS "warehouseBuildingId",
       i.code AS "itemCode",
       i.name AS "itemName",
       i.item_type AS "itemType",
       i.uom_id AS "itemUomId"
     FROM inventory_material_reservations r
     LEFT JOIN material_requests mr ON mr.id = r.material_request_id
     LEFT JOIN inventory_warehouses w ON w.id = r.warehouse_id
     LEFT JOIN inventory_items i ON i.id = r.item_id
     WHERE r.id = $1
       AND r.source_type = 'MATERIAL_REQUEST'`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function listByMaterialRequest(
  filters: MaterialReservationFilters,
): Promise<MaterialReservationRecord[]> {
  const conditions = [
    "material_request_id = $1",
    "source_type = 'MATERIAL_REQUEST'",
  ];
  const values: unknown[] = [filters.materialRequestId];

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<ReservationRow>(
    `SELECT ${SELECT}
     FROM inventory_material_reservations
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC, id DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

/**
 * Reads the demand calculation after the caller has locked the Material Request
 * row. All arithmetic and the admission decision happen in PostgreSQL NUMERIC.
 */
async function getDemandSnapshot(
  client: PoolClient,
  materialRequestId: string,
  requestedQuantity: number,
): Promise<MaterialReservationDemand & {
  reservationAllowed: boolean;
  issueAllowed: boolean;
}> {
  const result = await client.query<DemandRow>(
    `WITH issued AS (
       SELECT COALESCE(SUM(quantity), 0)::numeric AS quantity
       FROM inventory_work_order_material_usages
       WHERE material_request_id = $1
     ), active_reservations AS (
       SELECT COALESCE(SUM(remaining_quantity), 0)::numeric AS quantity
       FROM inventory_material_reservations
       WHERE material_request_id = $1
         AND source_type = 'MATERIAL_REQUEST'
         AND status = 'ACTIVE'
     )
     SELECT
       COALESCE(mr.approved_quantity, mr.quantity)::numeric AS "authorizedDemand",
       issued.quantity AS "cumulativeIssued",
       active_reservations.quantity AS "activeReserved",
       (
         COALESCE(mr.approved_quantity, mr.quantity)
         - issued.quantity
       )::numeric AS "remainingDemand",
       (
         COALESCE(mr.approved_quantity, mr.quantity)
         - issued.quantity
         - active_reservations.quantity
       )::numeric AS "reservableDemand",
       (
         $2::numeric <= (
           COALESCE(mr.approved_quantity, mr.quantity)
           - issued.quantity
           - active_reservations.quantity
         )
       ) AS "reservationAllowed",
       (
         $2::numeric <= (
           COALESCE(mr.approved_quantity, mr.quantity)
           - issued.quantity
         )
       ) AS "issueAllowed"
     FROM material_requests mr
     CROSS JOIN issued
     CROSS JOIN active_reservations
     WHERE mr.id = $1`,
    [materialRequestId, requestedQuantity],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Material Request demand snapshot was not found.');
  }

  return {
    authorizedDemand: Number(row.authorizedDemand),
    cumulativeIssued: Number(row.cumulativeIssued),
    activeReserved: Number(row.activeReserved),
    remainingDemand: Number(row.remainingDemand),
    reservableDemand: Number(row.reservableDemand),
    reservationAllowed: row.reservationAllowed,
    issueAllowed: row.issueAllowed,
  };
}

/** Locks one existing Item + Warehouse balance for the reservation command. */
async function findBalanceForUpdate(
  client: PoolClient,
  warehouseId: string,
  itemId: string,
): Promise<MaterialReservationBalanceRow | null> {
  const result = await client.query<MaterialReservationBalanceRow>(
    `SELECT
       id,
       quantity_on_hand AS "quantityOnHand",
       reserved_quantity AS "reservedQuantity",
       available_quantity AS "availableQuantity"
     FROM inventory_stock_balances
     WHERE warehouse_id = $1 AND item_id = $2
     FOR UPDATE`,
    [warehouseId, itemId],
  );
  return result.rows[0] ?? null;
}

/** Increases only the existing balance's reserved quantity; on-hand is untouched. */
async function increaseReservedQuantity(
  client: PoolClient,
  balanceId: string,
  quantity: number,
): Promise<MaterialReservationBalanceRow | null> {
  const result = await client.query<MaterialReservationBalanceRow>(
    `UPDATE inventory_stock_balances
     SET reserved_quantity = reserved_quantity + $1::numeric,
         updated_at = NOW()
     WHERE id = $2
       AND available_quantity >= $1::numeric
     RETURNING
       id,
       quantity_on_hand AS "quantityOnHand",
       reserved_quantity AS "reservedQuantity",
       available_quantity AS "availableQuantity"`,
    [quantity, balanceId],
  );
  return result.rows[0] ?? null;
}

/** Decreases only the existing balance's reserved quantity; never below zero. */
async function decreaseReservedQuantity(
  client: PoolClient,
  balanceId: string,
  quantity: number,
): Promise<MaterialReservationBalanceRow | null> {
  const result = await client.query<MaterialReservationBalanceRow>(
    `UPDATE inventory_stock_balances
     SET reserved_quantity = reserved_quantity - $1::numeric,
         updated_at = NOW()
     WHERE id = $2
       AND reserved_quantity >= $1::numeric
     RETURNING
       id,
       quantity_on_hand AS "quantityOnHand",
       reserved_quantity AS "reservedQuantity",
       available_quantity AS "availableQuantity"`,
    [quantity, balanceId],
  );
  return result.rows[0] ?? null;
}

/**
 * Consumes an active reservation allocation. Partial consumption remains
 * ACTIVE; exact consumption becomes terminal CONSUMED. The row is expected to
 * be locked after its Material Request and before its Stock Balance.
 */
async function consumeWithClient(
  client: PoolClient,
  id: string,
  quantity: number,
  actorUserId: string,
): Promise<MaterialReservationRecord | null> {
  const result = await client.query<ReservationRow>(
    `UPDATE inventory_material_reservations
     SET consumed_quantity = consumed_quantity + $2::numeric,
         status = CASE
           WHEN remaining_quantity = $2::numeric THEN 'CONSUMED'
           ELSE 'ACTIVE'
         END,
         consumed_at = CASE
           WHEN remaining_quantity = $2::numeric THEN NOW()
           ELSE NULL
         END,
         consumed_by_user_id = CASE
           WHEN remaining_quantity = $2::numeric THEN $3::uuid
           ELSE NULL
         END,
         updated_at = NOW()
     WHERE id = $1
       AND source_type = 'MATERIAL_REQUEST'
       AND status = 'ACTIVE'
       AND remaining_quantity >= $2::numeric
     RETURNING ${SELECT}`,
    [id, quantity, actorUserId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function countActiveByMaterialRequest(
  client: PoolClient,
  materialRequestId: string,
): Promise<number> {
  const result = await client.query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
     FROM inventory_material_reservations
     WHERE material_request_id = $1
       AND source_type = 'MATERIAL_REQUEST'
       AND status = 'ACTIVE'
       AND remaining_quantity > 0`,
    [materialRequestId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function transitionWithClient(
  client: PoolClient,
  id: string,
  status: 'RELEASED' | 'CANCELLED',
  actorUserId: string,
): Promise<MaterialReservationRecord | null> {
  const result = await client.query<ReservationRow>(
    status === 'RELEASED'
      ? `UPDATE inventory_material_reservations
         SET status = 'RELEASED',
             released_at = NOW(),
             released_by_user_id = $2,
             updated_at = NOW()
         WHERE id = $1
           AND source_type = 'MATERIAL_REQUEST'
           AND status = 'ACTIVE'
         RETURNING ${SELECT}`
      : `UPDATE inventory_material_reservations
         SET status = 'CANCELLED',
             cancelled_at = NOW(),
             cancelled_by_user_id = $2,
             updated_at = NOW()
         WHERE id = $1
           AND source_type = 'MATERIAL_REQUEST'
           AND status = 'ACTIVE'
         RETURNING ${SELECT}`,
    [id, actorUserId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * CR-HM-BE-07 RUN 2 — Handyman source adapter for the *existing* inventory
 * reservation authority. These helpers intentionally use the same physical
 * reservation and stock-balance table/locking mechanics as procurement while
 * keeping the legacy Material Request API source-typed and non-nullable.
 */
async function createHandymanWithClient(
  client: PoolClient,
  input: NewHandymanMaterialReservation,
): Promise<HandymanMaterialReservationRecord> {
  const result = await client.query<HandymanReservationRow>(
    `INSERT INTO inventory_material_reservations
       (id, client_id, building_id, source_type, handyman_material_demand_id,
        warehouse_id, item_id, uom_id, reserved_quantity, status,
        created_by_user_id, idempotency_key, idempotency_fingerprint, notes)
     VALUES ($1, $2, $3, 'HANDYMAN_MATERIAL_DEMAND', $4, $5, $6, $7, $8,
             'ACTIVE', $9, $10, $11, $12)
     RETURNING ${HANDYMAN_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.handymanMaterialDemandId,
      input.warehouseId,
      input.itemId,
      input.uomId,
      input.reservedQuantity,
      input.createdByUserId,
      input.idempotencyKey,
      input.idempotencyFingerprint,
      input.notes,
    ],
  );
  return mapHandymanRow(result.rows[0]);
}

async function findHandymanById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanMaterialReservationRecord | null> {
  const result = await executor.query<HandymanReservationRow>(
    `SELECT ${HANDYMAN_SELECT}
     FROM inventory_material_reservations
     WHERE id = $1
       AND source_type = 'HANDYMAN_MATERIAL_DEMAND'`,
    [id],
  );
  return result.rows[0] ? mapHandymanRow(result.rows[0]) : null;
}

/** Locks after the Handyman demand row, preserving source → reservation order. */
async function findHandymanByIdForUpdate(
  client: PoolClient,
  id: string,
): Promise<HandymanMaterialReservationRecord | null> {
  const result = await client.query<HandymanReservationRow>(
    `SELECT ${HANDYMAN_SELECT}
     FROM inventory_material_reservations
     WHERE id = $1
       AND source_type = 'HANDYMAN_MATERIAL_DEMAND'
     FOR UPDATE`,
    [id],
  );
  return result.rows[0] ? mapHandymanRow(result.rows[0]) : null;
}

async function findHandymanByIdempotencyKey(
  clientId: string,
  idempotencyKey: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanMaterialReservationRecord | null> {
  const result = await executor.query<HandymanReservationRow>(
    `SELECT ${HANDYMAN_SELECT}
     FROM inventory_material_reservations
     WHERE client_id = $1
       AND source_type = 'HANDYMAN_MATERIAL_DEMAND'
       AND idempotency_key = $2`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ? mapHandymanRow(result.rows[0]) : null;
}

async function findHandymanByTerminalIdempotencyKey(
  clientId: string,
  idempotencyKey: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanMaterialReservationRecord | null> {
  const result = await executor.query<HandymanReservationRow>(
    `SELECT ${HANDYMAN_SELECT}
     FROM inventory_material_reservations
     WHERE client_id = $1
       AND source_type = 'HANDYMAN_MATERIAL_DEMAND'
       AND terminal_idempotency_key = $2`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ? mapHandymanRow(result.rows[0]) : null;
}

/**
 * NUMERIC demand cap after the caller holds the Handyman demand row lock.
 * `cumulativeIssued` is deliberately gross controlled STOCK_OUT quantity:
 * normal returns never reopen demand capacity.
 */
async function getHandymanDemandSnapshot(
  client: PoolClient,
  handymanMaterialDemandId: string,
  requestedQuantity: number,
): Promise<HandymanMaterialReservationDemand> {
  const result = await client.query<HandymanDemandRow>(
    `WITH issued AS (
       SELECT COALESCE(SUM(quantity), 0)::numeric AS quantity
       FROM handyman_material_controlled_issues
       WHERE handyman_material_demand_id = $1
     ), active_reservations AS (
       SELECT COALESCE(SUM(remaining_quantity), 0)::numeric AS quantity
       FROM inventory_material_reservations
       WHERE handyman_material_demand_id = $1
         AND source_type = 'HANDYMAN_MATERIAL_DEMAND'
         AND status = 'ACTIVE'
     )
     SELECT
       d.quantity::numeric AS "authorizedDemand",
       issued.quantity AS "cumulativeIssued",
       active_reservations.quantity AS "activeReserved",
       (d.quantity - issued.quantity)::numeric AS "remainingDemand",
       (d.quantity - issued.quantity - active_reservations.quantity)::numeric
         AS "reservableDemand",
       ($2::numeric <= d.quantity - issued.quantity - active_reservations.quantity)
         AS "reservationAllowed",
       ($2::numeric <= d.quantity - issued.quantity) AS "reservedIssueAllowed",
       ($2::numeric <= d.quantity - issued.quantity - active_reservations.quantity)
         AS "unreservedIssueAllowed"
     FROM handyman_material_demands d
     CROSS JOIN issued
     CROSS JOIN active_reservations
     WHERE d.id = $1`,
    [handymanMaterialDemandId, requestedQuantity],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Handyman material demand snapshot was not found.');
  }
  return {
    authorizedDemand: Number(row.authorizedDemand),
    cumulativeIssued: Number(row.cumulativeIssued),
    activeReserved: Number(row.activeReserved),
    remainingDemand: Number(row.remainingDemand),
    reservableDemand: Number(row.reservableDemand),
    reservationAllowed: row.reservationAllowed,
    reservedIssueAllowed: row.reservedIssueAllowed,
    unreservedIssueAllowed: row.unreservedIssueAllowed,
  };
}

async function consumeHandymanWithClient(
  client: PoolClient,
  id: string,
  quantity: number,
  actorUserId: string,
): Promise<HandymanMaterialReservationRecord | null> {
  const result = await client.query<HandymanReservationRow>(
    `UPDATE inventory_material_reservations
     SET consumed_quantity = consumed_quantity + $2::numeric,
         status = CASE
           WHEN remaining_quantity = $2::numeric THEN 'CONSUMED'
           ELSE 'ACTIVE'
         END,
         consumed_at = CASE
           WHEN remaining_quantity = $2::numeric THEN NOW()
           ELSE NULL
         END,
         consumed_by_user_id = CASE
           WHEN remaining_quantity = $2::numeric THEN $3::uuid
           ELSE NULL
         END,
         updated_at = NOW()
     WHERE id = $1
       AND source_type = 'HANDYMAN_MATERIAL_DEMAND'
       AND status = 'ACTIVE'
       AND remaining_quantity >= $2::numeric
     RETURNING ${HANDYMAN_SELECT}`,
    [id, quantity, actorUserId],
  );
  return result.rows[0] ? mapHandymanRow(result.rows[0]) : null;
}

/** Releases/cancels only unconsumed allocation and records terminal replay facts. */
async function transitionHandymanWithClient(
  client: PoolClient,
  id: string,
  status: 'RELEASED' | 'CANCELLED',
  actorUserId: string,
  idempotencyKey: string,
  idempotencyFingerprint: string,
): Promise<HandymanMaterialReservationRecord | null> {
  const result = await client.query<HandymanReservationRow>(
    status === 'RELEASED'
      ? `UPDATE inventory_material_reservations
         SET status = 'RELEASED',
             released_at = NOW(),
             released_by_user_id = $2,
             terminal_idempotency_key = $3,
             terminal_idempotency_fingerprint = $4,
             updated_at = NOW()
         WHERE id = $1
           AND source_type = 'HANDYMAN_MATERIAL_DEMAND'
           AND status = 'ACTIVE'
         RETURNING ${HANDYMAN_SELECT}`
      : `UPDATE inventory_material_reservations
         SET status = 'CANCELLED',
             cancelled_at = NOW(),
             cancelled_by_user_id = $2,
             terminal_idempotency_key = $3,
             terminal_idempotency_fingerprint = $4,
             updated_at = NOW()
         WHERE id = $1
           AND source_type = 'HANDYMAN_MATERIAL_DEMAND'
           AND status = 'ACTIVE'
         RETURNING ${HANDYMAN_SELECT}`,
    [id, actorUserId, idempotencyKey, idempotencyFingerprint],
  );
  return result.rows[0] ? mapHandymanRow(result.rows[0]) : null;
}

async function countActiveByHandymanMaterialDemand(
  client: PoolClient,
  handymanMaterialDemandId: string,
): Promise<number> {
  const result = await client.query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
     FROM inventory_material_reservations
     WHERE handyman_material_demand_id = $1
       AND source_type = 'HANDYMAN_MATERIAL_DEMAND'
       AND status = 'ACTIVE'
       AND remaining_quantity > 0`,
    [handymanMaterialDemandId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export const inventoryMaterialReservationRepository = {
  consumeWithClient,
  consumeHandymanWithClient,
  countActiveByMaterialRequest,
  countActiveByHandymanMaterialDemand,
  createWithClient,
  createHandymanWithClient,
  decreaseReservedQuantity,
  findBalanceForUpdate,
  findById,
  findByIdForUpdate,
  findByIdWithDetails,
  findHandymanById,
  findHandymanByIdForUpdate,
  findHandymanByIdempotencyKey,
  findHandymanByTerminalIdempotencyKey,
  getDemandSnapshot,
  getHandymanDemandSnapshot,
  increaseReservedQuantity,
  listByMaterialRequest,
  transitionWithClient,
  transitionHandymanWithClient,
};
