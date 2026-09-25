import type { MaterialReservationDemand } from '../inventory-material-reservations/inventory-material-reservation.types';
import { permissionService } from '../permissions';
import { assertWorkOrderFieldActor } from '../work-order-actions';
import type { WorkOrderRecord } from '../work-orders/work-order.types';
import type { MobileMaterialRequestRow } from './mobile-material-request.repository';
import type {
  MobileMaterialRequestAvailableAction,
  MobileWorkOrderMaterialAvailableAction,
} from './mobile-material-request.types';

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 04 — the ONE read-only evaluator of the
 * closed RN-11 action vocabulary. Used by Work Order context (LIST), request
 * LIST rows, DETAIL, CREATE and CANCEL responses.
 *
 * AUTHORITY INPUTS (all server-side, never role names, never status alone):
 *   - effective permissions of the caller (BE-01E resolver — the same source
 *     `requirePermission` uses): `material_request.field.request`,
 *     `material_usage.field.record`
 *   - Building access (asserted by the caller BEFORE evaluation — an actor
 *     without Building access never reaches this evaluator)
 *   - BE-08F Work Order field-actor gate (`assertWorkOrderFieldActor`), the
 *     exact seam the CREATE / CANCEL / USAGE commands enforce
 *   - canonical Work Order status
 *   - canonical request status + the canonical demand summary
 *     (`DEMAND_SELECT`, shared with issue control)
 *
 * The result is a SNAPSHOT: every command re-validates authority and state
 * under row locks. Nothing here mutates.
 */

export const FIELD_REQUEST_PERMISSION = 'material_request.field.request';
export const FIELD_USAGE_PERMISSION = 'material_usage.field.record';

/** Work Order states the canonical usage engine refuses (mirrors recordMaterialUsage). */
const USAGE_BLOCKED_WORK_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'CANCELLED',
  'CLOSED',
]);

export type MobileMaterialActorContext = {
  workOrderId: string;
  workOrderStatus: string;
  canRequest: boolean;
  canRecordUsage: boolean;
  /** BE-08F field-actor gate result for this actor on this Work Order. */
  isFieldActor: boolean;
};

/**
 * Resolves the caller's authority for ONE Work Order in a bounded number of
 * reads (one permission resolution + one field-actor evaluation), so a LIST of
 * N requests never performs N authority queries.
 */
export async function resolveMobileMaterialActorContext(
  workOrder: WorkOrderRecord,
  actorUserId: string,
): Promise<MobileMaterialActorContext> {
  const permissions = await permissionService.resolvePermissionsForUser(actorUserId);
  const canRequest = permissions.includes(FIELD_REQUEST_PERMISSION);
  const canRecordUsage = permissions.includes(FIELD_USAGE_PERMISSION);

  let isFieldActor = false;
  if (canRequest || canRecordUsage) {
    // Same seam as the commands; a denial (no assignment / not the assignee)
    // simply means "no mutation token", it is not an error for a read.
    try {
      await assertWorkOrderFieldActor(workOrder.id, actorUserId);
      isFieldActor = true;
    } catch {
      isFieldActor = false;
    }
  }

  return {
    workOrderId: workOrder.id,
    workOrderStatus: workOrder.status,
    canRequest,
    canRecordUsage,
    isFieldActor,
  };
}

/** Work Order level: REQUEST_MATERIAL (demand is never gated by stock). */
export function evaluateMobileWorkOrderMaterialActions(
  ctx: MobileMaterialActorContext,
): MobileWorkOrderMaterialAvailableAction[] {
  const actions: MobileWorkOrderMaterialAvailableAction[] = [];
  if (ctx.canRequest && ctx.isFieldActor) {
    actions.push('REQUEST_MATERIAL');
  }
  return actions;
}

/**
 * Request level: CANCEL_MATERIAL_REQUEST / RECORD_MATERIAL_USAGE.
 *
 * CANCEL — field cancel guard verbatim: status OPEN AND no ACTIVE reservation
 * with remaining quantity (`countActiveByMaterialRequest` ⇔ SUM(ACTIVE
 * remaining) > 0, which is exactly `demand.activeReserved`).
 *
 * USAGE — APPROVED, remaining demand > 0, at least one ACTIVE reservation with
 * remaining > 0 (`demand.activeReserved > 0`; one or many — the PART 03 command
 * lets the technician name one), Work Order not COMPLETED / CANCELLED /
 * CLOSED. Stock sufficiency is NOT consulted here: the ACTIVE allocation is
 * the field authority; the command owns the final stock / race guards.
 */
export function evaluateMobileMaterialRequestActions(
  ctx: MobileMaterialActorContext,
  row: Pick<MobileMaterialRequestRow, 'status' | 'workOrderId'>,
  demand: MaterialReservationDemand,
): MobileMaterialRequestAvailableAction[] {
  const actions: MobileMaterialRequestAvailableAction[] = [];
  if (!ctx.isFieldActor || row.workOrderId !== ctx.workOrderId) {
    return actions;
  }
  if (ctx.canRequest && row.status === 'OPEN' && demand.activeReserved <= 0) {
    actions.push('CANCEL_MATERIAL_REQUEST');
  }
  if (
    ctx.canRecordUsage &&
    row.status === 'APPROVED' &&
    demand.remainingDemand > 0 &&
    demand.activeReserved > 0 &&
    !USAGE_BLOCKED_WORK_ORDER_STATUSES.has(ctx.workOrderStatus)
  ) {
    actions.push('RECORD_MATERIAL_USAGE');
  }
  return actions;
}
