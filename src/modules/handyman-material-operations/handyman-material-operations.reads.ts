import { getPool } from '../../database';
import type {
  PublicHandymanMaterialApproval,
  PublicHandymanMaterialDemand,
} from '../handyman-material-demands';
import type {
  PublicHandymanMaterialActualUsage,
  PublicHandymanMaterialControlledIssue,
  PublicHandymanMaterialReservation,
  PublicHandymanMaterialReturn,
} from '../handyman-material-inventory';
import type { HandymanMaterialDemandFulfillment } from './handyman-material-operations.types';

/**
 * CR-HM-BE-07 RUN 3 — SELECT-only read projections over the authoritative
 * Run-1/Run-2 facts. This module performs no INSERT/UPDATE/DELETE, takes no
 * locks, computes no authoritative caps, and decides no access: every
 * controller reads through an existing Run-1/Run-2 service function first
 * (which owns actor access), then scopes these queries to the resolved
 * demand/job/issue. Mappings mirror the domain Public shapes exactly and
 * expose no idempotency keys, fingerprints, names, or notes beyond the
 * operational description snapshot.
 */

function numberValue(value: string | number | null): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return iso(value);
}

type ReservationRow = {
  id: string;
  clientId: string;
  buildingId: string;
  handymanMaterialDemandId: string;
  warehouseId: string;
  itemId: string;
  uomId: string;
  reservedQuantity: string | number;
  consumedQuantity: string | number;
  remainingQuantity: string | number;
  status: PublicHandymanMaterialReservation['status'];
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

const RESERVATION_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
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
  notes,
  created_at AS "createdAt",
  released_at AS "releasedAt",
  cancelled_at AS "cancelledAt",
  consumed_at AS "consumedAt",
  updated_at AS "updatedAt"
`;

function mapReservation(row: ReservationRow): PublicHandymanMaterialReservation {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    sourceType: 'HANDYMAN_MATERIAL_DEMAND',
    handymanMaterialDemandId: row.handymanMaterialDemandId,
    warehouseId: row.warehouseId,
    itemId: row.itemId,
    uomId: row.uomId,
    reservedQuantity: numberValue(row.reservedQuantity),
    consumedQuantity: numberValue(row.consumedQuantity),
    remainingQuantity: numberValue(row.remainingQuantity),
    status: row.status,
    createdByUserId: row.createdByUserId,
    releasedByUserId: row.releasedByUserId ?? null,
    cancelledByUserId: row.cancelledByUserId ?? null,
    consumedByUserId: row.consumedByUserId ?? null,
    notes: row.notes ?? null,
    createdAt: iso(row.createdAt),
    releasedAt: nullableIso(row.releasedAt),
    cancelledAt: nullableIso(row.cancelledAt),
    consumedAt: nullableIso(row.consumedAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function listReservationsByDemand(
  handymanMaterialDemandId: string,
): Promise<PublicHandymanMaterialReservation[]> {
  const result = await getPool().query<ReservationRow>(
    `SELECT ${RESERVATION_SELECT}
     FROM inventory_material_reservations
     WHERE handyman_material_demand_id = $1
       AND source_type = 'HANDYMAN_MATERIAL_DEMAND'
     ORDER BY created_at ASC, id ASC`,
    [handymanMaterialDemandId],
  );
  return result.rows.map(mapReservation);
}

type IssueRow = {
  id: string;
  clientId: string;
  buildingId: string;
  handymanMaterialDemandId: string;
  handymanJobId: string;
  workOrderId: string;
  inventoryMaterialReservationId: string | null;
  warehouseId: string;
  itemId: string;
  uomId: string;
  handymanServiceVisitId: string | null;
  handymanWorkSessionId: string | null;
  inventoryStockMovementId: string;
  quantity: string | number;
  issuedByUserId: string;
  issuedAt: Date;
  reference: string | null;
  notes: string | null;
  createdAt: Date;
};

const ISSUE_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  handyman_material_demand_id AS "handymanMaterialDemandId",
  handyman_job_id AS "handymanJobId",
  work_order_id AS "workOrderId",
  inventory_material_reservation_id AS "inventoryMaterialReservationId",
  warehouse_id AS "warehouseId",
  item_id AS "itemId",
  uom_id AS "uomId",
  handyman_service_visit_id AS "handymanServiceVisitId",
  handyman_work_session_id AS "handymanWorkSessionId",
  inventory_stock_movement_id AS "inventoryStockMovementId",
  quantity,
  issued_by_user_id AS "issuedByUserId",
  issued_at AS "issuedAt",
  reference,
  notes,
  created_at AS "createdAt"
`;

function mapIssue(row: IssueRow): PublicHandymanMaterialControlledIssue {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    handymanMaterialDemandId: row.handymanMaterialDemandId,
    handymanJobId: row.handymanJobId,
    workOrderId: row.workOrderId,
    inventoryMaterialReservationId: row.inventoryMaterialReservationId ?? null,
    warehouseId: row.warehouseId,
    itemId: row.itemId,
    uomId: row.uomId,
    handymanServiceVisitId: row.handymanServiceVisitId ?? null,
    handymanWorkSessionId: row.handymanWorkSessionId ?? null,
    inventoryStockMovementId: row.inventoryStockMovementId,
    quantity: numberValue(row.quantity),
    issuedByUserId: row.issuedByUserId,
    issuedAt: iso(row.issuedAt),
    reference: row.reference ?? null,
    notes: row.notes ?? null,
    createdAt: iso(row.createdAt),
  };
}

export async function listIssuesByDemand(
  handymanMaterialDemandId: string,
): Promise<PublicHandymanMaterialControlledIssue[]> {
  const result = await getPool().query<IssueRow>(
    `SELECT ${ISSUE_SELECT}
     FROM handyman_material_controlled_issues
     WHERE handyman_material_demand_id = $1
     ORDER BY issued_at ASC, id ASC`,
    [handymanMaterialDemandId],
  );
  return result.rows.map(mapIssue);
}

export async function getIssueById(
  issueId: string,
): Promise<PublicHandymanMaterialControlledIssue | null> {
  const result = await getPool().query<IssueRow>(
    `SELECT ${ISSUE_SELECT}
     FROM handyman_material_controlled_issues
     WHERE id = $1`,
    [issueId],
  );
  return result.rows[0] ? mapIssue(result.rows[0]) : null;
}

type UsageRow = {
  id: string;
  clientId: string;
  buildingId: string;
  handymanMaterialDemandId: string;
  handymanJobId: string;
  workOrderId: string;
  handymanMaterialControlledIssueId: string | null;
  inventoryItemId: string | null;
  uomId: string;
  handymanServiceVisitId: string | null;
  handymanWorkSessionId: string | null;
  usageKind: PublicHandymanMaterialActualUsage['usageKind'];
  quantity: string | number;
  usedByUserId: string;
  usedAt: Date;
  notes: string | null;
  createdAt: Date;
};

const USAGE_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  handyman_material_demand_id AS "handymanMaterialDemandId",
  handyman_job_id AS "handymanJobId",
  work_order_id AS "workOrderId",
  handyman_material_controlled_issue_id AS "handymanMaterialControlledIssueId",
  inventory_item_id AS "inventoryItemId",
  uom_id AS "uomId",
  handyman_service_visit_id AS "handymanServiceVisitId",
  handyman_work_session_id AS "handymanWorkSessionId",
  usage_kind AS "usageKind",
  quantity,
  used_by_user_id AS "usedByUserId",
  used_at AS "usedAt",
  notes,
  created_at AS "createdAt"
`;

function mapUsage(row: UsageRow): PublicHandymanMaterialActualUsage {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    handymanMaterialDemandId: row.handymanMaterialDemandId,
    handymanJobId: row.handymanJobId,
    workOrderId: row.workOrderId,
    handymanMaterialControlledIssueId: row.handymanMaterialControlledIssueId ?? null,
    inventoryItemId: row.inventoryItemId ?? null,
    uomId: row.uomId,
    handymanServiceVisitId: row.handymanServiceVisitId ?? null,
    handymanWorkSessionId: row.handymanWorkSessionId ?? null,
    usageKind: row.usageKind,
    quantity: numberValue(row.quantity),
    usedByUserId: row.usedByUserId,
    usedAt: iso(row.usedAt),
    notes: row.notes ?? null,
    createdAt: iso(row.createdAt),
  };
}

export async function listUsagesByDemand(
  handymanMaterialDemandId: string,
): Promise<PublicHandymanMaterialActualUsage[]> {
  const result = await getPool().query<UsageRow>(
    `SELECT ${USAGE_SELECT}
     FROM handyman_material_actual_usages
     WHERE handyman_material_demand_id = $1
     ORDER BY used_at ASC, id ASC`,
    [handymanMaterialDemandId],
  );
  return result.rows.map(mapUsage);
}

type ReturnRow = {
  id: string;
  clientId: string;
  buildingId: string;
  handymanMaterialControlledIssueId: string;
  handymanMaterialDemandId: string;
  handymanJobId: string;
  workOrderId: string;
  warehouseId: string;
  itemId: string;
  uomId: string;
  inventoryStockMovementId: string;
  quantity: string | number;
  returnedByUserId: string;
  returnedAt: Date;
  reference: string | null;
  notes: string | null;
  createdAt: Date;
};

const RETURN_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  handyman_material_controlled_issue_id AS "handymanMaterialControlledIssueId",
  handyman_material_demand_id AS "handymanMaterialDemandId",
  handyman_job_id AS "handymanJobId",
  work_order_id AS "workOrderId",
  warehouse_id AS "warehouseId",
  item_id AS "itemId",
  uom_id AS "uomId",
  inventory_stock_movement_id AS "inventoryStockMovementId",
  quantity,
  returned_by_user_id AS "returnedByUserId",
  returned_at AS "returnedAt",
  reference,
  notes,
  created_at AS "createdAt"
`;

function mapReturn(row: ReturnRow): PublicHandymanMaterialReturn {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    handymanMaterialControlledIssueId: row.handymanMaterialControlledIssueId,
    handymanMaterialDemandId: row.handymanMaterialDemandId,
    handymanJobId: row.handymanJobId,
    workOrderId: row.workOrderId,
    warehouseId: row.warehouseId,
    itemId: row.itemId,
    uomId: row.uomId,
    inventoryStockMovementId: row.inventoryStockMovementId,
    quantity: numberValue(row.quantity),
    returnedByUserId: row.returnedByUserId,
    returnedAt: iso(row.returnedAt),
    reference: row.reference ?? null,
    notes: row.notes ?? null,
    createdAt: iso(row.createdAt),
  };
}

export async function listReturnsByIssue(
  issueId: string,
): Promise<PublicHandymanMaterialReturn[]> {
  const result = await getPool().query<ReturnRow>(
    `SELECT ${RETURN_SELECT}
     FROM handyman_material_returns
     WHERE handyman_material_controlled_issue_id = $1
     ORDER BY returned_at ASC, id ASC`,
    [issueId],
  );
  return result.rows.map(mapReturn);
}

type ApprovalRow = {
  id: string;
  clientId: string;
  handymanJobId: string;
  handymanRequestId: string;
  buildingId: string;
  commercialAddendumId: string;
  status: PublicHandymanMaterialApproval['status'];
  method: PublicHandymanMaterialApproval['method'];
  approvedForType: PublicHandymanMaterialApproval['approvedForType'];
  approvedForTenantCompanyId: string | null;
  approvedForTenantPicId: string | null;
  recordedByUserId: string | null;
  decidedAt: Date | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

function mapApproval(row: ApprovalRow): PublicHandymanMaterialApproval {
  return {
    id: row.id,
    clientId: row.clientId,
    handymanJobId: row.handymanJobId,
    handymanRequestId: row.handymanRequestId,
    buildingId: row.buildingId,
    commercialAddendumId: row.commercialAddendumId,
    status: row.status,
    method: row.method,
    approvedForType: row.approvedForType,
    approvedForTenantCompanyId: row.approvedForTenantCompanyId ?? null,
    approvedForTenantPicId: row.approvedForTenantPicId ?? null,
    recordedByUserId: row.recordedByUserId ?? null,
    decidedAt: nullableIso(row.decidedAt),
    cancelledAt: nullableIso(row.cancelledAt),
    cancelledByUserId: row.cancelledByUserId ?? null,
    createdByUserId: row.createdByUserId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** Job approval history; the controller asserts read access via Run-1 first. */
export async function listApprovalsByJob(
  handymanJobId: string,
): Promise<PublicHandymanMaterialApproval[]> {
  const result = await getPool().query<ApprovalRow>(
    `SELECT
       a.id,
       a.client_id AS "clientId",
       a.handyman_job_id AS "handymanJobId",
       a.handyman_request_id AS "handymanRequestId",
       a.building_id AS "buildingId",
       a.commercial_addendum_id AS "commercialAddendumId",
       a.status,
       a.method,
       a.approved_for_type AS "approvedForType",
       a.approved_for_tenant_company_id AS "approvedForTenantCompanyId",
       a.approved_for_tenant_pic_id AS "approvedForTenantPicId",
       a.recorded_by_user_id AS "recordedByUserId",
       a.decided_at AS "decidedAt",
       a.cancelled_at AS "cancelledAt",
       a.cancelled_by_user_id AS "cancelledByUserId",
       a.created_by_user_id AS "createdByUserId",
       a.created_at AS "createdAt",
       a.updated_at AS "updatedAt"
     FROM handyman_material_approvals a
     WHERE a.handyman_job_id = $1
     ORDER BY a.created_at ASC, a.id ASC`,
    [handymanJobId],
  );
  return result.rows.map(mapApproval);
}

type FulfillmentRow = {
  handymanJobId: string;
  supplySource: PublicHandymanMaterialDemand['supplySource'];
  commercialBasis: PublicHandymanMaterialDemand['commercialBasis'];
  demandStatus: PublicHandymanMaterialDemand['status'];
  demandQuantity: string | number;
  activeReservedQuantity: string | number;
  issuedQuantity: string | number;
  usedQuantity: string | number;
  returnedQuantity: string | number;
};

/**
 * Derived per-demand fulfillment. Pure aggregation; authoritative caps stay
 * Run-2 owned and no mutable fulfillment lifecycle is persisted.
 */
export async function getDemandFulfillment(
  handymanMaterialDemandId: string,
): Promise<HandymanMaterialDemandFulfillment | null> {
  const result = await getPool().query<FulfillmentRow>(
    `SELECT
       d.handyman_job_id AS "handymanJobId",
       d.supply_source AS "supplySource",
       d.commercial_basis AS "commercialBasis",
       d.status AS "demandStatus",
       d.quantity AS "demandQuantity",
       COALESCE((
         SELECT SUM(r.remaining_quantity)
         FROM inventory_material_reservations r
         WHERE r.handyman_material_demand_id = d.id
           AND r.source_type = 'HANDYMAN_MATERIAL_DEMAND'
           AND r.status = 'ACTIVE'
       ), 0)::numeric AS "activeReservedQuantity",
       COALESCE((
         SELECT SUM(i.quantity)
         FROM handyman_material_controlled_issues i
         WHERE i.handyman_material_demand_id = d.id
       ), 0)::numeric AS "issuedQuantity",
       COALESCE((
         SELECT SUM(u.quantity)
         FROM handyman_material_actual_usages u
         WHERE u.handyman_material_demand_id = d.id
       ), 0)::numeric AS "usedQuantity",
       COALESCE((
         SELECT SUM(t.quantity)
         FROM handyman_material_returns t
         JOIN handyman_material_controlled_issues i ON i.id = t.handyman_material_controlled_issue_id
         WHERE i.handyman_material_demand_id = d.id
       ), 0)::numeric AS "returnedQuantity"
     FROM handyman_material_demands d
     WHERE d.id = $1`,
    [handymanMaterialDemandId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const demandQuantity = numberValue(row.demandQuantity);
  const activeReservedQuantity = numberValue(row.activeReservedQuantity);
  const issuedQuantity = numberValue(row.issuedQuantity);
  const usedQuantity = numberValue(row.usedQuantity);
  const returnedQuantity = numberValue(row.returnedQuantity);
  const isProvider = row.supplySource === 'PROVIDER_STOCK';
  const remainingDemandQuantity = isProvider
    ? demandQuantity - issuedQuantity - activeReservedQuantity
    : demandQuantity - usedQuantity;
  const fulfillmentStatus = isProvider
    ? issuedQuantity >= demandQuantity
      ? 'FULFILLED'
      : issuedQuantity > 0 || activeReservedQuantity > 0
        ? 'PARTIALLY_FULFILLED'
        : 'WAITING_FOR_MATERIAL'
    : usedQuantity >= demandQuantity
      ? 'FULFILLED'
      : usedQuantity > 0
        ? 'PARTIALLY_FULFILLED'
        : 'WAITING_FOR_MATERIAL';
  return {
    handymanMaterialDemandId,
    handymanJobId: row.handymanJobId,
    supplySource: row.supplySource,
    commercialBasis: row.commercialBasis,
    demandStatus: row.demandStatus,
    demandQuantity,
    activeReservedQuantity,
    issuedQuantity,
    usedQuantity,
    returnedQuantity,
    remainingDemandQuantity,
    fulfillmentStatus,
  };
}
