import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import {
  assetNotFoundError,
  assetRepository,
  assetRetiredError,
  resolveAssetBuildingContext,
} from '../assets';
import { buildingService } from '../buildings';
import { contextAccessService } from '../context-access';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { recordOperationalEvent } from '../operational-events';
import {
  breakdownClosedError,
  breakdownInvalidTransitionError,
  breakdownLocationBuildingMismatchError,
  breakdownNotFoundError,
  breakdownWorkOrderAlreadyLinkedError,
  breakdownWorkOrderBuildingMismatchError,
} from './breakdown-binding.errors';
import {
  breakdownBindingRepository,
  type CorrectiveWorkOrderRow,
} from './breakdown-binding.repository';
import {
  type BreakdownBindingRecord,
  type BreakdownCorrectiveState,
  type CreateBreakdownInput,
  type LinkCorrectiveWorkOrderInput,
  type PublicBreakdownBinding,
} from './breakdown-binding.types';
import { workOrderService } from '../work-orders';

/**
 * BE-10F — Breakdown / Corrective Binding service.
 *
 * Records breakdown/corrective events against BE-05 Assets and links them to
 * corrective BE-08 Work Orders. The Work Order is created and driven
 * exclusively through the BE-08 service (createWorkOrder +
 * bindWorkOrderContext); its lifecycle, assignments (BE-03/BE-06), evidence,
 * verification, and any Finding workflow remain BE-08's / BE-09's. The
 * corrective status returned by this module is always projected from the
 * linked Work Order's authoritative BE-08 status — never stored.
 *
 * Validation order (pinned by tests):
 *   1. unknown Asset                 → 404 ASSET_NOT_FOUND
 *   2. inaccessible Asset Building   → 403 BUILDING_ACCESS_DENIED
 *   3. non-ACTIVE Asset              → 409 ASSET_RETIRED / 400 BAD_REQUEST
 *   4. unknown Functional Location   → 404 FUNCTIONAL_LOCATION_NOT_FOUND
 *   5. cross-Building location       → 400 BREAKDOWN_LOCATION_BUILDING_MISMATCH
 *   6. INACTIVE location             → 400 BAD_REQUEST
 *   (Work Order link:)
 *   7. unknown breakdown             → 404 BREAKDOWN_NOT_FOUND
 *   8. CLOSED breakdown              → 400 BREAKDOWN_CLOSED
 *   9. already linked                → 409 BREAKDOWN_WORK_ORDER_ALREADY_LINKED
 *  10. unknown Work Order            → 404 WORK_ORDER_NOT_FOUND
 *  11. cross-Building Work Order     → 400 BREAKDOWN_WORK_ORDER_BUILDING_MISMATCH
 */
export async function createBreakdown(
  input: CreateBreakdownInput,
  userId: string,
): Promise<PublicBreakdownBinding> {
  const asset = await assetRepository.findById(input.assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, asset.buildingId);
  assertOperationalAsset(asset.status);

  const functionalLocationId = await assertBreakdownLocation(
    input.functionalLocationId ?? null,
    asset.buildingId,
  );

  const { clientId } = await resolveAssetBuildingContext(asset.buildingId);
  const reportedAt = input.reportedAt ? new Date(input.reportedAt) : new Date();

  const record = await breakdownBindingRepository.create({
    clientId,
    buildingId: asset.buildingId,
    assetId: asset.id,
    functionalLocationId,
    category: input.category,
    description: input.description,
    reportedByUserId: userId,
    reportedAt,
  });

  await recordOperationalEvent({
    clientId,
    eventType: 'BREAKDOWN_RECORDED',
    entityType: 'BREAKDOWN_BINDING',
    entityId: record.id,
    actorUserId: userId,
    buildingId: asset.buildingId,
    summary: `Breakdown recorded for asset ${asset.assetCode}`,
    metadata: {
      assetId: asset.id,
      category: input.category,
      functionalLocationId,
    },
  });

  return toPublicBreakdownBinding(record, null);
}

export async function getBreakdown(
  id: string,
  userId: string,
): Promise<PublicBreakdownBinding> {
  const record = await breakdownBindingRepository.findById(id);
  if (!record) {
    throw breakdownNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  const corrective = await resolveCorrectiveState(record);
  return toPublicBreakdownBinding(record, corrective);
}

export async function listBreakdownsByAsset(
  assetId: string,
  userId: string,
): Promise<PublicBreakdownBinding[]> {
  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, asset.buildingId);
  const records = await breakdownBindingRepository.listByAssetId(assetId);
  return Promise.all(
    records.map(async (record) =>
      toPublicBreakdownBinding(record, await resolveCorrectiveState(record)),
    ),
  );
}

export async function listBreakdownsByBuilding(
  buildingId: string,
  userId: string,
): Promise<PublicBreakdownBinding[]> {
  const building = await buildingService.getBuildingById(buildingId);
  await contextAccessService.assertBuildingAccess(userId, building.id);
  const records = await breakdownBindingRepository.listByBuildingId(building.id);
  return Promise.all(
    records.map(async (record) =>
      toPublicBreakdownBinding(record, await resolveCorrectiveState(record)),
    ),
  );
}

/**
 * Links an existing corrective Work Order or creates a new one through the
 * BE-08 flow. A newly created Work Order is bound to the breakdown's Asset /
 * Functional Location via BE-08's own context binding, so the corrective
 * context can never drift from BE-05 / BE-04.
 */
export async function linkCorrectiveWorkOrder(
  id: string,
  input: LinkCorrectiveWorkOrderInput,
  userId: string,
): Promise<PublicBreakdownBinding> {
  const breakdown = await breakdownBindingRepository.findById(id);
  if (!breakdown) {
    throw breakdownNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, breakdown.buildingId);
  if (breakdown.status === 'CLOSED') {
    throw breakdownClosedError();
  }
  if (breakdown.workOrderId) {
    throw breakdownWorkOrderAlreadyLinkedError();
  }

  let workOrderId: string;
  if (input.workOrderId) {
    const workOrder = await workOrderService.getWorkOrderById(input.workOrderId);
    if (workOrder.buildingId !== breakdown.buildingId) {
      throw breakdownWorkOrderBuildingMismatchError();
    }
    workOrderId = workOrder.id;
  } else {
    const workOrder = await workOrderService.createWorkOrder({
      clientId: breakdown.clientId,
      buildingId: breakdown.buildingId,
      workOrderNumber: `BC_${randomUUID().slice(0, 8).toUpperCase()}`,
      title: input.title ?? `Corrective: ${breakdown.category}`,
      workType: 'CORRECTIVE',
      createdByUserId: userId,
    });
    // BE-08 owns the Asset / Location context binding and its validation.
    await workOrderService.bindWorkOrderContext(workOrder.id, {
      assetId: breakdown.assetId,
      functionalLocationId: breakdown.functionalLocationId,
    });
    workOrderId = workOrder.id;
  }

  const updated = await breakdownBindingRepository.linkWorkOrder(id, workOrderId);
  if (!updated) {
    throw breakdownNotFoundError();
  }

  await recordOperationalEvent({
    clientId: breakdown.clientId,
    eventType: 'BREAKDOWN_WORK_ORDER_LINKED',
    entityType: 'BREAKDOWN_BINDING',
    entityId: breakdown.id,
    actorUserId: userId,
    buildingId: breakdown.buildingId,
    summary: `Corrective work order linked to breakdown for asset ${breakdown.assetId}`,
    metadata: { workOrderId },
  });

  return toPublicBreakdownBinding(
    updated,
    await resolveCorrectiveState(updated),
  );
}

/**
 * Closes the breakdown record. OPEN → CLOSED only; the corrective Work Order
 * lifecycle is never touched here (BE-08 remains its sole authority).
 */
export async function closeBreakdown(
  id: string,
  userId: string,
): Promise<PublicBreakdownBinding> {
  const breakdown = await breakdownBindingRepository.findById(id);
  if (!breakdown) {
    throw breakdownNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, breakdown.buildingId);
  if (breakdown.status !== 'OPEN') {
    throw breakdownInvalidTransitionError();
  }

  const updated = await breakdownBindingRepository.updateStatus(id, 'CLOSED');
  if (!updated) {
    throw breakdownNotFoundError();
  }

  await recordOperationalEvent({
    clientId: breakdown.clientId,
    eventType: 'BREAKDOWN_CLOSED',
    entityType: 'BREAKDOWN_BINDING',
    entityId: breakdown.id,
    actorUserId: userId,
    buildingId: breakdown.buildingId,
    summary: `Breakdown closed for asset ${breakdown.assetId}`,
    metadata: { category: breakdown.category },
  });

  return toPublicBreakdownBinding(updated, await resolveCorrectiveState(updated));
}

/** BE-05 lifecycle governs binding eligibility: only ACTIVE assets record breakdowns. */
function assertOperationalAsset(status: string): void {
  if (status === 'RETIRED') {
    throw assetRetiredError();
  }
  if (status !== 'ACTIVE') {
    throw AppError.badRequest(
      'Assets must be ACTIVE to record breakdowns.',
    );
  }
}

/** Validates an optional BE-04 Functional Location refinement (BE-10 convention). */
async function assertBreakdownLocation(
  functionalLocationId: string | null,
  assetBuildingId: string,
): Promise<string | null> {
  if (functionalLocationId === null) {
    return null;
  }
  const location = await functionalLocationRepository.findById(
    functionalLocationId,
  );
  if (!location) {
    throw functionalLocationNotFoundError();
  }
  if (location.buildingId !== assetBuildingId) {
    throw breakdownLocationBuildingMismatchError();
  }
  if (location.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'Inactive functional locations cannot receive breakdown bindings.',
    );
  }
  return location.id;
}

/** Projects the corrective status from the linked BE-08 Work Order. */
async function resolveCorrectiveState(
  record: BreakdownBindingRecord,
): Promise<BreakdownCorrectiveState> {
  if (!record.workOrderId) {
    return null;
  }
  const workOrder = await breakdownBindingRepository.findCorrectiveWorkOrder(
    record.workOrderId,
  );
  return workOrder ? toCorrectiveState(workOrder) : null;
}

function toCorrectiveState(
  workOrder: CorrectiveWorkOrderRow,
): NonNullable<BreakdownCorrectiveState> {
  return {
    workOrderId: workOrder.work_order_id,
    workOrderNumber: workOrder.work_order_number,
    title: workOrder.title,
    status: workOrder.status,
  };
}

export function toPublicBreakdownBinding(
  record: BreakdownBindingRecord,
  corrective: BreakdownCorrectiveState,
): PublicBreakdownBinding {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    assetId: record.assetId,
    functionalLocationId: record.functionalLocationId,
    category: record.category,
    description: record.description,
    reportedByUserId: record.reportedByUserId,
    reportedAt: record.reportedAt.toISOString(),
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    corrective,
  };
}

export const breakdownBindingService = {
  closeBreakdown,
  createBreakdown,
  getBreakdown,
  linkCorrectiveWorkOrder,
  listBreakdownsByAsset,
  listBreakdownsByBuilding,
};
