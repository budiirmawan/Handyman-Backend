import { withTransaction } from '../../database';
import { contextAccessService } from '../context-access';
import {
  createMaterialRequest,
  materialRequestNotFoundError,
  materialRequestNotOpenError,
  materialRequestRepository,
} from '../material-requests';
import { materialRequestActiveReservationError } from '../material-requests/material-request.errors';
import { inventoryMaterialReservationRepository } from '../inventory-material-reservations/inventory-material-reservation.repository';
import { recordMaterialUsage } from '../inventory-work-order-material-usages/inventory-wo-material-usage.service';
import {
  woMaterialUsageActiveReservationRequiredError,
  woMaterialUsageMaterialRequestInvalidError,
  woMaterialUsageReservationMismatchError,
  woMaterialUsageReservationRequiredError,
} from '../inventory-work-order-material-usages/inventory-wo-material-usage.errors';
import { materialReservationNotActiveError, materialReservationNotFoundError } from '../inventory-material-reservations/inventory-material-reservation.errors';
import { recordOperationalEvent } from '../operational-events';
import { getOrCreateWorkOrderFieldPurchaseRequest } from '../purchase-requests';
import {
  computeRequestFingerprint,
  executeIdempotent,
} from '../request-idempotency';
import { assertWorkOrderFieldActor } from '../work-order-actions';
import { workOrderNotFoundError, workOrderRepository } from '../work-orders';
import type { WorkOrderRecord } from '../work-orders/work-order.types';
import type { MaterialReservationDemand } from '../inventory-material-reservations/inventory-material-reservation.types';
import {
  mobileMaterialRequestRepository,
  type MobileMaterialIssueRow,
  type MobileMaterialItemRow,
  type MobileMaterialRequestRow,
  type MobileMaterialReservationRow,
} from './mobile-material-request.repository';
import {
  evaluateMobileMaterialRequestActions,
  evaluateMobileWorkOrderMaterialActions,
  resolveMobileMaterialActorContext,
  type MobileMaterialActorContext,
} from './mobile-material-action.evaluator';
import type {
  MobileMaterialIssue,
  MobileMaterialItem,
  MobileMaterialRequest,
  MobileMaterialRequestDetail,
  MobileMaterialRequestFulfillment,
  MobileMaterialRequestInput,
  MobileMaterialReservation,
  MobileMaterialUsageInput,
  MobileMaterialUsageResult,
  MobileWorkOrderMaterialContext,
} from './mobile-material-request.types';

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 01 — Work-Order-bound field material
 * requests.
 *
 * ONE concern: let the technician executing a Work Order raise, see and
 * (while still OPEN) withdraw material DEMAND. The record is a canonical
 * BE-17B material_request under the Work Order's single field Purchase
 * Request (PART 00 `getOrCreateWorkOrderFieldPurchaseRequest`). Nothing about
 * material-request creation is re-implemented: the same BE-17B service, the
 * same validation order (item scope, UOM rule), the same status model.
 *
 * AUTHORITY CHAIN — all server-side, all BEFORE the idempotency claim so a
 * denied call can never poison a key:
 *   1. authenticated (`authenticationMiddleware`)
 *   2. `material_request.field.request` / `material_request.field.read`
 *      (route) — deliberately NOT material_request.manage /
 *      purchase_request.manage / inventory_stock.manage / wo_procurement.manage
 *   3. Work Order exists                                  → 404 WORK_ORDER_NOT_FOUND
 *   4. Building access to the Work Order's Building       → 403 BUILDING_ACCESS_DENIED
 *   5. CREATE/CANCEL only: BE-08F Work Order field gate
 *      (`assertWorkOrderFieldActor`: active assignment + actor is assignee /
 *      team member / vendor workforce)                    → 400 / 403
 *
 * HARD NON-EFFECTS: no reservation, no stock movement, no balance change, no
 * usage, no return, no approval, no procurement-approval, no
 * work_order_procurement_bindings write. A request is demand, not issue —
 * current stock is never consulted.
 *
 * IDEMPOTENCY (CREATE): generic request-idempotency core, operationKey
 * `createMobileWorkOrderMaterialRequest`, fingerprint =
 * { workOrderId, itemId, quantity, uomId, notes } — no parent id, request
 * number, client/building, actor, status or timestamps. Claim + parent
 * get-or-create + material_request + WORK_ORDER_MATERIAL_REQUESTED event +
 * stored response commit in ONE transaction; replay returns the stored
 * response and emits nothing.
 */

export const CREATE_MOBILE_MATERIAL_REQUEST_OPERATION_KEY =
  'createMobileWorkOrderMaterialRequest';

export const WORK_ORDER_MATERIAL_REQUESTED_EVENT = 'WORK_ORDER_MATERIAL_REQUESTED';
export const WORK_ORDER_MATERIAL_REQUEST_CANCELLED_EVENT =
  'WORK_ORDER_MATERIAL_REQUEST_CANCELLED';
/** PART 03 — idempotency operation key of the field usage command. */
export const RECORD_MOBILE_MATERIAL_USAGE_OPERATION_KEY = 'recordMobileWorkOrderMaterialUsage';

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);

/**
 * PART 02 — fulfillment from the canonical demand summary. `demand` is the
 * SAME arithmetic issue control uses (`getDemandSnapshot`); this module only
 * renames fields for the field contract and never recomputes them.
 */
export function toMobileFulfillment(
  row: MobileMaterialRequestRow,
  demand: MaterialReservationDemand,
): MobileMaterialRequestFulfillment {
  return {
    requestedQuantity: Number(row.quantity),
    approvedQuantity: num(row.approvedQuantity),
    activeReservedQuantity: demand.activeReserved,
    cumulativeIssuedQuantity: demand.cumulativeIssued,
    remainingDemandQuantity: demand.remainingDemand,
  };
}

const warehouseRef = (r: {
  warehouseId: string;
  warehouseCode: string | null;
  warehouseName: string | null;
}) =>
  r.warehouseCode !== null
    ? { id: r.warehouseId, code: r.warehouseCode, name: r.warehouseName ?? '' }
    : null;

export function toMobileMaterialReservation(
  r: MobileMaterialReservationRow,
): MobileMaterialReservation {
  return {
    id: r.id,
    materialRequestId: r.materialRequestId,
    warehouseId: r.warehouseId,
    warehouse: warehouseRef(r),
    reservedQuantity: Number(r.reservedQuantity),
    consumedQuantity: Number(r.consumedQuantity),
    remainingQuantity: Number(r.remainingQuantity),
    status: r.status,
    createdAt: iso(r.createdAt) as string,
    updatedAt: iso(r.updatedAt) as string,
  };
}

export function toMobileMaterialIssue(r: MobileMaterialIssueRow): MobileMaterialIssue {
  return {
    id: r.id,
    materialRequestId: r.materialRequestId,
    reservationId: r.reservationId,
    warehouseId: r.warehouseId,
    warehouse: warehouseRef(r),
    itemId: r.itemId,
    quantity: Number(r.quantity),
    uomId: r.uomId,
    usedAt: iso(r.usedAt) as string,
    usedByUserId: r.usedByUserId,
    reference: r.reference,
    notes: r.notes,
    stockMovementId: r.stockMovementId,
  };
}

export function toMobileMaterialItem(r: MobileMaterialItemRow): MobileMaterialItem {
  return {
    itemId: r.itemId,
    code: r.code,
    name: r.name,
    itemType: r.itemType,
    uom:
      r.uomId && r.uomCode
        ? { id: r.uomId, code: r.uomCode, name: r.uomName ?? '', symbol: r.uomSymbol ?? '' }
        : null,
  };
}

/**
 * Fetches canonical demand for the rows in ONE bounded query and maps them,
 * attaching the PART 04 action snapshot from ONE actor context (no per-row
 * authority queries).
 */
async function withFulfillment(
  rows: MobileMaterialRequestRow[],
  ctx: MobileMaterialActorContext,
  executor?: Parameters<typeof inventoryMaterialReservationRepository.getDemandSummaries>[1],
): Promise<MobileMaterialRequest[]> {
  const demand = await inventoryMaterialReservationRepository.getDemandSummaries(
    rows.map((r) => r.id),
    executor,
  );
  return rows.map((row) => {
    const d = demand.get(row.id);
    if (!d) throw new Error('Material Request demand summary was not found.');
    return toMobileMaterialRequest(row, d, ctx);
  });
}

async function oneWithFulfillment(
  row: MobileMaterialRequestRow,
  ctx: MobileMaterialActorContext,
  executor?: Parameters<typeof inventoryMaterialReservationRepository.getDemandSummaries>[1],
): Promise<MobileMaterialRequest> {
  const [dto] = await withFulfillment([row], ctx, executor);
  return dto as MobileMaterialRequest;
}

export function toMobileMaterialRequest(
  row: MobileMaterialRequestRow,
  demand: MaterialReservationDemand,
  ctx: MobileMaterialActorContext,
): MobileMaterialRequest {
  return {
    id: row.id,
    workOrderId: row.workOrderId,
    purchaseRequestId: row.purchaseRequestId,
    purchaseRequestNumber: row.purchaseRequestNumber,
    item: { id: row.itemId, code: row.itemCode, name: row.itemName, itemType: row.itemType },
    quantity: Number(row.quantity),
    approvedQuantity: num(row.approvedQuantity),
    uomId: row.uomId,
    uom:
      row.uomId && row.uomCode
        ? { id: row.uomId, code: row.uomCode, name: row.uomName ?? '', symbol: row.uomSymbol ?? '' }
        : null,
    requiredDate: iso(row.requiredDate),
    notes: row.notes,
    status: row.status,
    requestedByUserId: row.requestedByUserId,
    createdAt: iso(row.createdAt) as string,
    updatedAt: iso(row.updatedAt) as string,
    fulfillment: toMobileFulfillment(row, demand),
    availableActions: evaluateMobileMaterialRequestActions(ctx, row, demand),
  };
}

async function loadWorkOrderWithBuildingAccess(
  workOrderId: string,
  actorUserId: string,
): Promise<WorkOrderRecord> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) throw workOrderNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, workOrder.buildingId);
  return workOrder;
}

/**
 * GET /mobile/work-orders/:workOrderId/material-requests  (PART 04 envelope)
 *
 * Work Order material CONTEXT: `{ workOrderId, availableActions,
 * materialRequests[] }` — the client gets REQUEST_MATERIAL authority even
 * when the Work Order has zero requests. Bounded: WO + Building access, ONE
 * permission resolution + ONE field-actor evaluation, ONE list, ONE demand
 * summary.
 */
export async function listMobileWorkOrderMaterialRequests(
  workOrderId: string,
  actorUserId: string,
): Promise<MobileWorkOrderMaterialContext> {
  const workOrder = await loadWorkOrderWithBuildingAccess(workOrderId, actorUserId);
  const ctx = await resolveMobileMaterialActorContext(workOrder, actorUserId);
  const rows = await mobileMaterialRequestRepository.listByWorkOrder(workOrder.id);
  return {
    workOrderId: workOrder.id,
    availableActions: evaluateMobileWorkOrderMaterialActions(ctx),
    materialRequests: await withFulfillment(rows, ctx),
  };
}

/**
 * GET /mobile/work-orders/:workOrderId/material-items  (PART 02)
 *
 * Items the technician MAY request for this Work Order: the Work Order's
 * Client scope, the same rule `createMaterialRequest` enforces. Identity +
 * UOM only — no on-hand / available / reserved figures, no stock permission.
 */
export async function listMobileWorkOrderMaterialItems(
  workOrderId: string,
  actorUserId: string,
): Promise<MobileMaterialItem[]> {
  const workOrder = await loadWorkOrderWithBuildingAccess(workOrderId, actorUserId);
  const rows = await mobileMaterialRequestRepository.listRequestableItemsByClient(workOrder.clientId);
  return rows.map(toMobileMaterialItem);
}

/**
 * GET /mobile/material-requests/:materialRequestId
 *
 * A material request whose parent is not a Work-Order field parent is
 * reported as 404 MATERIAL_REQUEST_NOT_FOUND (same as a foreign id) — the
 * field surface neither exposes nor confirms management demand.
 */
export async function getMobileMaterialRequest(
  materialRequestId: string,
  actorUserId: string,
): Promise<MobileMaterialRequestDetail> {
  const row = await mobileMaterialRequestRepository.findFieldById(materialRequestId);
  if (!row) throw materialRequestNotFoundError();
  const workOrder = await loadWorkOrderWithBuildingAccess(row.workOrderId, actorUserId);
  const ctx = await resolveMobileMaterialActorContext(workOrder, actorUserId);
  const [base, reservations, issues] = await Promise.all([
    oneWithFulfillment(row, ctx),
    mobileMaterialRequestRepository.listReservationsByMaterialRequest(row.id),
    mobileMaterialRequestRepository.listIssuesByMaterialRequest(row.id),
  ]);
  return {
    ...base,
    reservations: reservations.map(toMobileMaterialReservation),
    issues: issues.map(toMobileMaterialIssue),
  };
}

/**
 * POST /mobile/work-orders/:workOrderId/material-usages  (PART 03)
 *
 * FIELD FACADE over the canonical usage/issue engine (`recordMaterialUsage`).
 * A usage row IS the physical issue (STOCK_OUT); there is no second
 * "consumption" lifecycle, no return, no reversal here.
 *
 * AUTHORITY (all BEFORE the idempotency claim): authenticated +
 * `material_usage.field.record` (route) + Building access via the Work Order
 * + BE-08F `assertWorkOrderFieldActor`.
 *
 * OWNERSHIP: the material request MUST be a Work-Order FIELD request of this
 * Work Order (`purchase_requests.work_order_id == workOrderId`); a legacy
 * binding alone never admits a management request to the mobile route
 * (400 INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_INVALID — the field
 * surface does not confirm foreign existence).
 *
 * RESERVATION RESOLUTION (technician never chooses a warehouse):
 *   reservationId given → must exist, ACTIVE, belong to the request
 *   omitted, exactly 1 ACTIVE → auto-selected
 *   omitted, 0 ACTIVE  → 409 INVENTORY_WO_MATERIAL_USAGE_ACTIVE_RESERVATION_REQUIRED
 *   omitted, >1 ACTIVE → 409 INVENTORY_WO_MATERIAL_USAGE_RESERVATION_REQUIRED
 * warehouseId := reservation.warehouseId; itemId / uomId := material request;
 * usedByUserId := actor; usedAt := server; no cost/currency (non-costed usage).
 *
 * Everything else (APPROVED, demand cap, allocation, stock, WO state, locks,
 * STOCK_OUT, usage row, WORK_ORDER_MATERIAL_ISSUED event) is the canonical
 * engine, executed inside the idempotency transaction (executor seam).
 */
export async function recordMobileWorkOrderMaterialUsage(
  workOrderId: string,
  actorUserId: string,
  input: MobileMaterialUsageInput,
  idempotencyKey: string,
): Promise<{ data: MobileMaterialUsageResult; replayed: boolean }> {
  const workOrder = await loadWorkOrderWithBuildingAccess(workOrderId, actorUserId);
  await assertWorkOrderFieldActor(workOrder.id, actorUserId);

  // Field ownership proof (PART 00 relation) — pre-claim, so a foreign id
  // never poisons the key.
  const fieldRow = await mobileMaterialRequestRepository.findFieldById(input.materialRequestId);
  if (!fieldRow || fieldRow.workOrderId !== workOrder.id) {
    throw woMaterialUsageMaterialRequestInvalidError();
  }

  const requestFingerprint = computeRequestFingerprint({
    workOrderId: workOrder.id,
    materialRequestId: fieldRow.id,
    reservationId: input.reservationId ?? null,
    quantity: input.quantity,
    notes: input.notes ?? null,
  });

  const result = await executeIdempotent({
    actorUserId,
    operationKey: RECORD_MOBILE_MATERIAL_USAGE_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      // Server-side reservation resolution; the canonical engine re-locks and
      // re-validates the chosen row (FOR UPDATE) inside the same transaction.
      const reservationId = await resolveFieldReservation(fieldRow.id, input.reservationId, client);
      const reservation = await inventoryMaterialReservationRepository.findById(reservationId);
      if (!reservation) throw materialReservationNotFoundError();
      if (reservation.materialRequestId !== fieldRow.id) throw woMaterialUsageReservationMismatchError();

      const usage = await recordMaterialUsage(
        {
          workOrderId: workOrder.id,
          materialRequestId: fieldRow.id,
          reservationId: reservation.id,
          warehouseId: reservation.warehouseId,
          itemId: fieldRow.itemId,
          ...(fieldRow.uomId ? { uomId: fieldRow.uomId } : {}),
          quantity: input.quantity,
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          usedByUserId: actorUserId,
        },
        client,
      );
      const issue = await findIssueRow(usage.id, client);
      return { responseStatus: 201, responseBody: { usage: issue } };
    },
  });

  return { data: result.responseBody as MobileMaterialUsageResult, replayed: result.replayed };
}

async function resolveFieldReservation(
  materialRequestId: string,
  requestedReservationId: string | undefined,
  client: Parameters<typeof inventoryMaterialReservationRepository.getDemandSummaries>[1],
): Promise<string> {
  if (requestedReservationId !== undefined) {
    const reservation = await inventoryMaterialReservationRepository.findById(requestedReservationId);
    if (!reservation || reservation.materialRequestId !== materialRequestId) {
      throw materialReservationNotFoundError();
    }
    if (reservation.status !== 'ACTIVE') throw materialReservationNotActiveError();
    return reservation.id;
  }
  const active = await mobileMaterialRequestRepository.listActiveReservationIds(materialRequestId, client);
  if (active.length === 0) throw woMaterialUsageActiveReservationRequiredError();
  if (active.length > 1) throw woMaterialUsageReservationRequiredError();
  return active[0] as string;
}

async function findIssueRow(
  usageId: string,
  client: Parameters<typeof inventoryMaterialReservationRepository.getDemandSummaries>[1],
): Promise<MobileMaterialIssue> {
  const row = await mobileMaterialRequestRepository.findIssueById(usageId, client);
  if (!row) throw new Error('Recorded material usage row was not found.');
  return toMobileMaterialIssue(row);
}

/** POST /mobile/work-orders/:workOrderId/material-requests */
export async function createMobileWorkOrderMaterialRequest(
  workOrderId: string,
  actorUserId: string,
  input: MobileMaterialRequestInput,
  idempotencyKey: string,
): Promise<{ data: MobileMaterialRequest; replayed: boolean }> {
  // Authority BEFORE the claim — never poison the key.
  const workOrder = await loadWorkOrderWithBuildingAccess(workOrderId, actorUserId);
  await assertWorkOrderFieldActor(workOrder.id, actorUserId);
  // PART 04 — same evaluator as LIST/DETAIL; the stored response carries the
  // snapshot taken at creation (replay returns it verbatim).
  const ctx = await resolveMobileMaterialActorContext(workOrder, actorUserId);

  const requestFingerprint = computeRequestFingerprint({
    workOrderId: workOrder.id,
    itemId: input.itemId,
    quantity: input.quantity,
    uomId: input.uomId,
    notes: input.notes ?? null,
  });

  const result = await executeIdempotent({
    actorUserId,
    operationKey: CREATE_MOBILE_MATERIAL_REQUEST_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      const parent = await getOrCreateWorkOrderFieldPurchaseRequest(
        workOrder,
        actorUserId,
        client,
      );
      const created = await createMaterialRequest(
        {
          purchaseRequestId: parent.id,
          itemId: input.itemId,
          quantity: input.quantity,
          uomId: input.uomId,
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          requestedByUserId: actorUserId,
        },
        client,
      );
      await recordOperationalEvent(
        {
          clientId: workOrder.clientId,
          buildingId: workOrder.buildingId,
          entityType: 'WORK_ORDER',
          entityId: workOrder.id,
          eventType: WORK_ORDER_MATERIAL_REQUESTED_EVENT,
          actorUserId,
          summary: `Material requested from field for work order ${workOrder.workOrderNumber}`,
          metadata: {
            workOrderId: workOrder.id,
            materialRequestId: created.id,
            purchaseRequestId: parent.id,
            itemId: created.itemId,
            quantity: created.quantity,
            uomId: created.uomId,
            requestedByUserId: actorUserId,
            requestedAt: created.createdAt,
          },
        },
        client,
      );
      const row = await mobileMaterialRequestRepository.findFieldById(created.id, client);
      if (!row) throw materialRequestNotFoundError();
      return { responseStatus: 201, responseBody: await oneWithFulfillment(row, ctx, client) };
    },
  });

  return { data: result.responseBody as MobileMaterialRequest, replayed: result.replayed };
}

/**
 * POST /mobile/material-requests/:materialRequestId/cancel
 *
 * Conservative field withdrawal: ONLY `OPEN` → `CANCELLED`. APPROVED demand
 * (management approval already granted), already-CANCELLED rows and any
 * request with an ACTIVE reservation are refused, even though the management
 * cancel (BE-17B) may go further. Same row lock and reservation guard as the
 * canonical cancel; no reservation release, no stock effect.
 *
 * Not idempotent by key: the canonical reconciliation read after an
 * ambiguous outcome is `GET /mobile/material-requests/{id}` (status
 * CANCELLED ⇒ done; OPEN ⇒ retry). No automatic replay.
 */
export async function cancelMobileMaterialRequest(
  materialRequestId: string,
  actorUserId: string,
): Promise<MobileMaterialRequest> {
  const row = await mobileMaterialRequestRepository.findFieldById(materialRequestId);
  if (!row) throw materialRequestNotFoundError();
  const workOrder = await loadWorkOrderWithBuildingAccess(row.workOrderId, actorUserId);
  await assertWorkOrderFieldActor(workOrder.id, actorUserId);
  const ctx = await resolveMobileMaterialActorContext(workOrder, actorUserId);

  const updated = await withTransaction(async (client) => {
    const locked = await materialRequestRepository.findByIdForUpdate(client, row.id);
    if (!locked) throw materialRequestNotFoundError();
    // Field guard: stricter than the management OPEN|APPROVED rule.
    if (locked.status !== 'OPEN') throw materialRequestNotOpenError();
    const active = await inventoryMaterialReservationRepository.countActiveByMaterialRequest(
      client,
      locked.id,
    );
    if (active > 0) throw materialRequestActiveReservationError();
    const cancelled = await materialRequestRepository.updateStatusWithClient(
      client,
      locked.id,
      'CANCELLED',
    );
    if (!cancelled) throw materialRequestNotFoundError();
    await recordOperationalEvent(
      {
        clientId: workOrder.clientId,
        buildingId: workOrder.buildingId,
        entityType: 'WORK_ORDER',
        entityId: workOrder.id,
        eventType: WORK_ORDER_MATERIAL_REQUEST_CANCELLED_EVENT,
        actorUserId,
        summary: `Field material request cancelled for work order ${workOrder.workOrderNumber}`,
        metadata: {
          workOrderId: workOrder.id,
          materialRequestId: cancelled.id,
          purchaseRequestId: cancelled.purchaseRequestId,
          itemId: cancelled.itemId,
          quantity: cancelled.quantity,
          uomId: cancelled.uomId,
        },
      },
      client,
    );
    const fresh = await mobileMaterialRequestRepository.findFieldById(cancelled.id, client);
    if (!fresh) throw materialRequestNotFoundError();
    return fresh;
  });
  return oneWithFulfillment(updated, ctx);
}

export const mobileMaterialRequestService = {
  recordMobileWorkOrderMaterialUsage,
  cancelMobileMaterialRequest,
  createMobileWorkOrderMaterialRequest,
  getMobileMaterialRequest,
  listMobileWorkOrderMaterialRequests,
  listMobileWorkOrderMaterialItems,
  toMobileMaterialRequest,
};
