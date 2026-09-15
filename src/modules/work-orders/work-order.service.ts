import { withTransaction } from '../../database';
import { applyToNewWorkOrder } from '../applied-slas/applied-sla.service';
import { satisfyClock, terminateClocks } from '../applied-slas/sla-clock-lifecycle.service';
import {
  assetNotFoundError,
  assetRepository,
  assetRetiredError,
} from '../assets';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import { contextAccessService } from '../context-access';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import {
  resolveBuildingContext,
  resolveFunctionalLocationContext,
} from '../structure-context';
import { resolveBuildingClientId } from '../shifts';
import {
  workOrderAssignmentRepository,
  type WorkOrderAssignmentRecord,
} from '../work-order-assignments';
import { workOrderEvidenceRepository } from '../work-order-evidence';
import { recordWorkOrderEvent } from '../work-order-history';
import { workforceRepository } from '../workforce';
import { vendorWorkforceRepository } from '../vendor-workforce';
import {
  workRequestNotOpenError,
  workRequestNotFoundError,
  workRequestRepository,
  workRequestService,
  workRequestTerminalStateError,
} from '../work-requests';
import {
  workOrderAssetBuildingMismatchError,
  workOrderAssetLocationInconsistentError,
  workOrderBastRequirementLockedError,
  workOrderBuildingClientMismatchError,
  workOrderCompletionAlreadyCompletedError,
  workOrderCompletionEvidenceIncompleteError,
  workOrderCompletionInvalidStateError,
  workOrderCompletionNoAssignmentError,
  workOrderCompletionUnauthorizedError,
  workOrderFromRequestAlreadyExistsError,
  workOrderInvalidTransitionError,
  workOrderLocationBuildingMismatchError,
  workOrderLocationInactiveError,
  workOrderNotFoundError,
  workOrderNotOpenError,
  workOrderNumberAlreadyExistsError,
} from './work-order.errors';
import { workOrderRepository } from './work-order.repository';
import { normalizeWorkOrderNumber, normalizeWorkType } from './work-order.validation';
import {
  canTransitionWorkOrderStatus,
  type CompleteWorkOrderServiceInput,
  type CreateWorkOrderFromRequestInput,
  type CreateWorkOrderInput,
  type NewWorkOrder,
  type PublicWorkOrder,
  type UpdateWorkOrderBastRequirementInput,
  type UpdateWorkOrderContextInput,
  type UpdateWorkOrderInput,
  type UpdateWorkOrderPriorityInput,
  type UpdateWorkOrderStatusInput,
  type WorkOrderCompletionReadiness,
  type WorkOrderContext,
  type WorkOrderFilters,
  type WorkOrderRecord,
} from './work-order.types';

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toPublicWorkOrder(record: WorkOrderRecord): PublicWorkOrder {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    workOrderNumber: record.workOrderNumber,
    workRequestId: record.workRequestId,
    title: record.title,
    description: record.description,
    workType: record.workType,
    priority: record.priority,
    status: record.status,
    bastRequirement: record.bastRequirement,
    createdByUserId: record.createdByUserId,
    assetId: record.assetId,
    functionalLocationId: record.functionalLocationId,
    assignedAt: iso(record.assignedAt),
    startedAt: iso(record.startedAt),
    completedAt: iso(record.completedAt),
    completedByUserId: record.completedByUserId,
    completionSummary: record.completionSummary,
    completionNotes: record.completionNotes,
    closedAt: iso(record.closedAt),
    cancelledAt: iso(record.cancelledAt),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Directly creates a Work Order under a Building, owned by the supplied
 * Client. The Client must exist and be ACTIVE, and the Building must resolve
 * — through Property → Client — to that same Client. The creator is the
 * authenticated user (guaranteed to exist by the session). Work Order number
 * uniqueness is enforced within the Client scope.
 *
 * Validation order (pinned by tests):
 *   1. unknown Client                  → 404 CLIENT_NOT_FOUND
 *   2. INACTIVE Client                 → 400 CLIENT_INACTIVE
 *   3. unknown Building                → 404 BUILDING_NOT_FOUND
 *   4. Building owned by another Client → 400 WORK_ORDER_BUILDING_CLIENT_MISMATCH
 *   5. duplicate work order number     → 409 WORK_ORDER_NUMBER_ALREADY_EXISTS
 */
export async function createWorkOrder(
  input: CreateWorkOrderInput,
): Promise<PublicWorkOrder> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  const buildingClientId = await resolveBuildingClientId(input.buildingId);
  if (buildingClientId !== input.clientId) {
    throw workOrderBuildingClientMismatchError();
  }

  const existing = await workOrderRepository.findByWorkOrderNumberForClient(
    input.clientId,
    normalizeWorkOrderNumber(input.workOrderNumber),
  );
  if (existing) {
    throw workOrderNumberAlreadyExistsError();
  }

  const newWorkOrder: NewWorkOrder = {
    clientId: input.clientId,
    buildingId: input.buildingId,
    workOrderNumber: normalizeWorkOrderNumber(input.workOrderNumber),
    workRequestId: null,
    title: input.title,
    description: input.description?.trim() || null,
    workType: normalizeWorkType(input.workType),
    createdByUserId: input.createdByUserId,
  };

  try {
    const record = await withTransaction(async (tx) => {
      const created = await workOrderRepository.create(newWorkOrder, tx);
      await applyToNewWorkOrder(created, tx);
      return created;
    });
    await recordWorkOrderEvent({
      workOrderId: record.id,
      clientId: record.clientId,
      buildingId: record.buildingId,
      eventType: 'WORK_ORDER_CREATED',
      actorUserId: input.createdByUserId,
      summary: `Work order ${record.workOrderNumber} created`,
      metadata: { workOrderNumber: record.workOrderNumber, workType: record.workType },
    });
    return toPublicWorkOrder(record);
  } catch (error) {
    if (isWorkOrderNumberUniqueViolation(error)) {
      throw workOrderNumberAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Converts an existing Work Request into a Work Order.
 *
 * The Work Order inherits `client_id` and `building_id` from the Work Request
 * (there is no client/building to supply — the request's context is the only
 * valid target). The source request must be OPEN: a CANCELLED request cannot
 * be converted, a CONVERTED request is terminal, and a request that already
 * produced a Work Order must not create a duplicate. On success the request
 * is marked CONVERTED using BE-08A behavior (`workRequestService`), so
 * terminal-state protection stays consistent with BE-08A.
 *
 * Validation order (pinned by tests):
 *   1. unknown Work Request            → 404 WORK_REQUEST_NOT_FOUND
 *   2. CANCELLED Work Request          → 400 WORK_REQUEST_NOT_OPEN
 *   3. request already converted       → 409 WORK_ORDER_FROM_REQUEST_ALREADY_EXISTS
 *   4. CONVERTED Work Request          → 400 WORK_REQUEST_TERMINAL_STATE
 *   5. duplicate work order number     → 409 WORK_ORDER_NUMBER_ALREADY_EXISTS
 */
export async function createWorkOrderFromRequest(
  input: CreateWorkOrderFromRequestInput,
): Promise<PublicWorkOrder> {
  const request = await workRequestRepository.findById(input.workRequestId);
  if (!request) {
    throw workRequestNotFoundError();
  }
  if (request.status === 'CANCELLED') {
    throw workRequestNotOpenError();
  }

  const existingFromRequest = await workOrderRepository.findByWorkRequestId(
    request.id,
  );
  if (existingFromRequest) {
    throw workOrderFromRequestAlreadyExistsError();
  }

  if (request.status === 'CONVERTED') {
    throw workRequestTerminalStateError();
  }

  const newWorkOrder: NewWorkOrder = {
    clientId: request.clientId,
    buildingId: request.buildingId,
    workOrderNumber: normalizeWorkOrderNumber(input.workOrderNumber),
    workRequestId: request.id,
    title: input.title,
    description: input.description?.trim() || null,
    workType: normalizeWorkType(input.workType),
    createdByUserId: input.createdByUserId,
  };

  let record;
  try {
    record = await withTransaction(async (tx) => {
      const created = await workOrderRepository.create(newWorkOrder, tx);
      await applyToNewWorkOrder(created, tx);
      return created;
    });
  } catch (error) {
    if (isWorkOrderNumberUniqueViolation(error)) {
      throw workOrderNumberAlreadyExistsError();
    }
    throw error;
  }

  // Mark the source request CONVERTED using BE-08A behavior.
  await workRequestService.convertWorkRequest(request.id);

  await recordWorkOrderEvent({
    workOrderId: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    eventType: 'WORK_ORDER_CONVERTED',
    actorUserId: input.createdByUserId,
    summary: `Work order ${record.workOrderNumber} converted from work request ${request.requestNumber}`,
    metadata: { workOrderNumber: record.workOrderNumber, workRequestId: request.id },
  });

  return toPublicWorkOrder(record);
}

export async function getWorkOrderById(id: string): Promise<PublicWorkOrder> {
  const record = await workOrderRepository.findById(id);
  if (!record) {
    throw workOrderNotFoundError();
  }
  return toPublicWorkOrder(record);
}

/**
 * Lists the Work Orders of one Building, optionally filtered by `status`,
 * `workType`, and `workRequestId`. The Building is validated first (unknown
 * Building → 404 rather than an empty list). Queries stay scoped to
 * `building_id`, so the list can never leak another Building's or Client's
 * orders.
 */
export async function listWorkOrdersByBuilding(
  buildingId: string,
  filters: WorkOrderFilters,
): Promise<PublicWorkOrder[]> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const records = await workOrderRepository.listByBuilding(buildingId, filters);
  return records.map(toPublicWorkOrder);
}

/**
 * CR-BE-MOB-03 PART 04 — team-scoped Work Order read (TMW-04).
 *
 * Self-service supervisor read: the caller's team is derived from the
 * authenticated session — the linked, ACTIVE BE-03C Workforce Profile's
 * `team_id` (the same authority `getMobileMyTeam` uses) — never from a
 * caller-supplied id. A Work Order is "relevant to the team" when its ACTIVE
 * BE-08E assignment targets the team itself (`assignee_type = 'TEAM'`) or an
 * ACTIVE member of the team (`assignee_type = 'WORKFORCE'` whose profile is
 * in the team). Results are constrained in SQL to the caller's BE-02G
 * accessible Building set, so Client/Building isolation holds even though no
 * building parameter is supplied. Read-only: the Work Order lifecycle,
 * statuses and authoritative ids are the existing BE-08 ones; nothing is
 * written and no mobile facade is created.
 *
 * A caller with no linked ACTIVE profile, no team, or no accessible Building
 * gets an empty list — never an error and never a widened scope.
 */
export async function listTeamWorkOrders(
  userId: string,
  filters: WorkOrderFilters,
): Promise<PublicWorkOrder[]> {
  const profile = await workforceRepository.findByUserId(userId);
  if (!profile || profile.status !== 'ACTIVE' || !profile.teamId) {
    return [];
  }

  const members = (await workforceRepository.listByTeamId(profile.teamId))
    .filter((member) => member.status === 'ACTIVE')
    .map((member) => member.id);

  const buildingIds = await contextAccessService.getAccessibleBuildingIds(
    userId,
  );
  if (buildingIds.length === 0) {
    return [];
  }

  const records = await workOrderRepository.listByTeamAssignments(
    profile.teamId,
    members,
    buildingIds,
    filters,
  );
  return records.map(toPublicWorkOrder);
}

/**
 * Partially updates an OPEN Work Order (title, description, workType).
 * `client_id`, `building_id`, `work_order_number`, `work_request_id`, and
 * `created_by_user_id` are immutable. Only OPEN Work Orders are mutable in
 * this PART (BE-08C adds detailed lifecycle).
 */
export async function updateWorkOrder(
  id: string,
  input: UpdateWorkOrderInput,
): Promise<PublicWorkOrder> {
  const existing = await workOrderRepository.findById(id);
  if (!existing) {
    throw workOrderNotFoundError();
  }
  if (existing.status !== 'OPEN') {
    throw workOrderNotOpenError();
  }

  const record = await workOrderRepository.update(id, input);
  return toPublicWorkOrder(record as WorkOrderRecord);
}

/**
 * Updates a Work Order's priority (LOW/MEDIUM/HIGH/CRITICAL). Priority is
 * metadata and may be adjusted in any lifecycle state, including after
 * completion (for reporting); it is not a lifecycle action.
 */
export async function updateWorkOrderPriority(
  id: string,
  input: UpdateWorkOrderPriorityInput,
): Promise<PublicWorkOrder> {
  const existing = await workOrderRepository.findById(id);
  if (!existing) {
    throw workOrderNotFoundError();
  }

  const record = await workOrderRepository.updatePriority(id, input.priority);
  await recordWorkOrderEvent({
    workOrderId: existing.id,
    clientId: existing.clientId,
    buildingId: existing.buildingId,
    eventType: 'WORK_ORDER_PRIORITY_CHANGED',
    summary: `Work order priority changed from ${existing.priority} to ${input.priority}`,
    metadata: { from: existing.priority, to: input.priority },
  });
  return toPublicWorkOrder(record as WorkOrderRecord);
}

/**
 * Changes the future BAST acceptance cardinality while policy is still safe to
 * edit. PART 01 does not use this value to block Work Order completion or
 * closure; it only exposes an audited, backend-owned policy for later phases.
 */
export async function updateWorkOrderBastRequirement(
  id: string,
  input: UpdateWorkOrderBastRequirementInput,
  actorUserId: string,
): Promise<PublicWorkOrder> {
  const existing = await workOrderRepository.findById(id);
  if (!existing) {
    throw workOrderNotFoundError();
  }
  if (existing.bastRequirement === input.bastRequirement) {
    return toPublicWorkOrder(existing);
  }

  const terminalOrCompleted = ['COMPLETED', 'CLOSED', 'CANCELLED'].includes(
    existing.status,
  );
  if (
    terminalOrCompleted ||
    (await workOrderRepository.hasBastSubmissionAttempts(existing.id))
  ) {
    throw workOrderBastRequirementLockedError();
  }

  const record = await workOrderRepository.updateBastRequirement(
    id,
    input.bastRequirement,
  );
  // The repository repeats both locks in the UPDATE predicate so a concurrent
  // completion or first submission attempt cannot race this policy change.
  if (!record) {
    throw workOrderBastRequirementLockedError();
  }
  await recordWorkOrderEvent({
    workOrderId: existing.id,
    clientId: existing.clientId,
    buildingId: existing.buildingId,
    eventType: 'WORK_ORDER_BAST_REQUIREMENT_CHANGED',
    actorUserId,
    summary: `Work order BAST requirement changed from ${existing.bastRequirement} to ${input.bastRequirement}`,
    metadata: {
      from: existing.bastRequirement,
      to: input.bastRequirement,
    },
  });
  return toPublicWorkOrder(record);
}

/**
 * Validates and applies a lifecycle transition (e.g. OPEN → ASSIGNED,
 * IN_PROGRESS → ON_HOLD, COMPLETED → CLOSED). The allowed transitions are
 * driven by the explicit table in `WORK_ORDER_TRANSITIONS` — no generic
 * workflow engine. Terminal states (CANCELLED, CLOSED) have no outgoing
 * transitions, so reverse and silent terminal-state changes are rejected.
 */
export async function transitionWorkOrderStatus(
  id: string,
  input: UpdateWorkOrderStatusInput,
): Promise<PublicWorkOrder> {
  const existing = await workOrderRepository.findById(id);
  if (!existing) {
    throw workOrderNotFoundError();
  }

  if (
    !canTransitionWorkOrderStatus(existing.status, input.status)
  ) {
    throw workOrderInvalidTransitionError(existing.status, input.status);
  }

  const record = await withTransaction(async (tx) => {
    const changed = await workOrderRepository.updateStatus(id, input.status, tx);
    if (changed && input.status === 'CANCELLED') {
      await terminateClocks(changed, changed.cancelledAt!, tx);
    }
    return changed;
  });
  await recordWorkOrderEvent({
    workOrderId: existing.id,
    clientId: existing.clientId,
    buildingId: existing.buildingId,
    eventType: 'WORK_ORDER_STATUS_CHANGED',
    summary: `Work order status changed from ${existing.status} to ${input.status}`,
    metadata: { from: existing.status, to: input.status },
  });
  return toPublicWorkOrder(record as WorkOrderRecord);
}

/**
 * BE-08D — validates an Asset before it is bound to a Work Order.
 *
 * The Asset must exist and belong to the SAME Building as the Work Order
 * (which also rejects every cross-Client binding, since a Building belongs to
 * exactly one Client through Property). A RETIRED Asset is terminal and cannot
 * receive a new Work Order binding, following the BE-05E lifecycle.
 */
async function assertWorkOrderAsset(
  workOrder: WorkOrderRecord,
  assetId: string,
): Promise<void> {
  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  if (asset.buildingId !== workOrder.buildingId) {
    throw workOrderAssetBuildingMismatchError();
  }
  if (asset.status === 'RETIRED') {
    throw assetRetiredError();
  }
}

/**
 * BE-08D — validates a Functional Location before it is bound to a Work Order.
 *
 * The BE-04 structure is the ONLY authority for where a location sits: the
 * caller supplies a Functional Location id and nothing else, and the Building
 * is read from the stored record — never from the request. An INACTIVE
 * location cannot receive a new binding, following the BE-04 convention.
 */
async function assertWorkOrderLocation(
  workOrder: WorkOrderRecord,
  functionalLocationId: string,
): Promise<void> {
  const location = await functionalLocationRepository.findById(
    functionalLocationId,
  );
  if (!location) {
    throw functionalLocationNotFoundError();
  }
  if (location.buildingId !== workOrder.buildingId) {
    throw workOrderLocationBuildingMismatchError();
  }
  if (location.status !== 'ACTIVE') {
    throw workOrderLocationInactiveError();
  }
}

/**
 * BE-08D — binds (or clears) an Asset and/or Functional Location on a Work
 * Order. The authoritative hierarchy is never trusted from the client; the
 * Asset and Functional Location are resolved through the existing BE-04/05
 * masters and validated against the Work Order's own Building.
 *
 * Validation order (pinned by tests):
 *   1. unknown Work Order                → 404 WORK_ORDER_NOT_FOUND
 *   2. unknown Asset (when supplied)     → 404 ASSET_NOT_FOUND
 *   3. Asset of a different Building     → 400 WORK_ORDER_ASSET_BUILDING_MISMATCH
 *   4. RETIRED Asset                     → 409 ASSET_RETIRED
 *   5. unknown Functional Location       → 404 FUNCTIONAL_LOCATION_NOT_FOUND
 *   6. location of a different Building  → 400 WORK_ORDER_LOCATION_BUILDING_MISMATCH
 *   7. INACTIVE location (new binding)   → 400 WORK_ORDER_LOCATION_INACTIVE
 *   8. Asset / Location inconsistency    → 400 WORK_ORDER_ASSET_LOCATION_INCONSISTENT
 */
export async function bindWorkOrderContext(
  id: string,
  input: UpdateWorkOrderContextInput,
): Promise<PublicWorkOrder> {
  const existing = await workOrderRepository.findById(id);
  if (!existing) {
    throw workOrderNotFoundError();
  }

  if (input.assetId !== undefined && input.assetId !== null) {
    await assertWorkOrderAsset(existing, input.assetId);
  }
  if (input.functionalLocationId !== undefined && input.functionalLocationId !== null) {
    await assertWorkOrderLocation(existing, input.functionalLocationId);
  }

  const effectiveAssetId =
    input.assetId !== undefined ? input.assetId : existing.assetId;
  const effectiveLocationId =
    input.functionalLocationId !== undefined
      ? input.functionalLocationId
      : existing.functionalLocationId;

  // Both are non-null: the Functional Location must resolve to the same
  // Building as the Asset (hierarchy consistency).
  if (effectiveAssetId !== null && effectiveLocationId !== null) {
    const asset = await assetRepository.findById(effectiveAssetId);
    const location = await functionalLocationRepository.findById(
      effectiveLocationId,
    );
    if (asset && location && asset.buildingId !== location.buildingId) {
      throw workOrderAssetLocationInconsistentError();
    }
  }

  const record = await workOrderRepository.updateContext(
    id,
    input.assetId,
    input.functionalLocationId,
  );
  await recordWorkOrderEvent({
    workOrderId: existing.id,
    clientId: existing.clientId,
    buildingId: existing.buildingId,
    eventType: 'WORK_ORDER_CONTEXT_CHANGED',
    summary: 'Work order asset/location binding changed',
    metadata: {
      from: { assetId: existing.assetId, functionalLocationId: existing.functionalLocationId },
      to: { assetId: input.assetId, functionalLocationId: input.functionalLocationId },
    },
  });
  return toPublicWorkOrder(record as WorkOrderRecord);
}

/**
 * BE-08D — returns the authoritative resolved Asset / Location context of a
 * Work Order. The operational context is projected through the BE-04H resolver
 * (never stored), so it can never drift from the Building Digital Structure.
 */
export async function getWorkOrderContext(id: string): Promise<WorkOrderContext> {
  const record = await workOrderRepository.findById(id);
  if (!record) {
    throw workOrderNotFoundError();
  }

  let assetContext: WorkOrderContext['asset'] = null;
  if (record.assetId) {
    const asset = await assetRepository.findById(record.assetId);
    if (asset) {
      assetContext = {
        id: asset.id,
        assetCode: asset.assetCode,
        assetName: asset.assetName,
        status: asset.status,
        functionalLocationId: asset.functionalLocationId,
      };
    }
  }

  let locationContext: WorkOrderContext['functionalLocation'] = null;
  if (record.functionalLocationId) {
    const location = await functionalLocationRepository.findById(
      record.functionalLocationId,
    );
    if (location) {
      locationContext = {
        id: location.id,
        code: location.code,
        name: location.name,
        status: location.status,
        spaceId: location.spaceId,
      };
    }
  }

  // Resolve the operational context from the most specific location reference.
  let operationalContext;
  if (record.functionalLocationId) {
    operationalContext = await resolveFunctionalLocationContext(
      record.functionalLocationId,
    );
  } else if (assetContext?.functionalLocationId) {
    operationalContext = await resolveFunctionalLocationContext(
      assetContext.functionalLocationId,
    );
  } else {
    operationalContext = await resolveBuildingContext(record.buildingId);
  }

  return {
    workOrderId: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    asset: assetContext,
    functionalLocation: locationContext,
    operationalContext,
  };
}

/**
 * Returns true when the acting user is the assignee (or a member of the
 * assigned team / bound to the assigned vendor) of the active assignment —
 * the same authorization rule BE-08F uses for execution actions.
 */
async function isCompletionActorAuthorized(
  actorUserId: string,
  assignment: WorkOrderAssignmentRecord,
): Promise<boolean> {
  const profile = await workforceRepository.findByUserId(actorUserId);
  if (!profile) {
    return false;
  }
  switch (assignment.assigneeType) {
    case 'WORKFORCE':
      return profile.id === assignment.workforceProfileId;
    case 'TEAM':
      return profile.teamId !== null && profile.teamId === assignment.teamId;
    case 'VENDOR':
      return (
        assignment.vendorId !== null &&
        (await vendorWorkforceRepository.findActiveByVendorAndWorkforce(
          assignment.vendorId,
          profile.id,
        )) !== null
      );
    case 'VENDOR_WORKFORCE':
      return profile.id === assignment.workforceProfileId;
  }
}

/**
 * Resolves the list of Work Order evidence requirement types whose active
 * submission count is below the requirement's minimum — i.e. the missing
 * required evidence, reusing the BE-07 evidence repository (no duplicated
 * evidence logic).
 */
async function findMissingRequiredEvidence(
  workOrderId: string,
): Promise<string[]> {
  const requirements =
    await workOrderEvidenceRepository.listRequirementsForWorkOrder(workOrderId);
  const submissions =
    await workOrderEvidenceRepository.listSubmissionsForWorkOrder(workOrderId);

  const missing: string[] = [];
  for (const req of requirements) {
    const count = submissions.filter(
      (s) => s.evidenceRequirementId === req.id && s.status === 'ACTIVE',
    ).length;
    if (count < req.minimumCount) {
      missing.push(req.evidenceType);
    }
  }
  return missing;
}

/**
 * BE-08H — validates Work Order completion readiness without mutating state.
 * Reuses the BE-08C lifecycle, BE-08E assignment, and BE-08G evidence rules.
 *
 * Validation order (pinned by tests):
 *   1. unknown Work Order              → 404 WORK_ORDER_NOT_FOUND
 *   2. already COMPLETED               → 409 WORK_ORDER_COMPLETION_ALREADY_COMPLETED
 *   3. invalid state (not IN_PROGRESS) → 400 WORK_ORDER_COMPLETION_INVALID_STATE
 *   4. no active assignment            → 400 WORK_ORDER_COMPLETION_NO_ASSIGNMENT
 *   5. actor not authorized            → 403 WORK_ORDER_COMPLETION_UNAUTHORIZED
 */
export async function validateWorkOrderCompletionReadiness(
  workOrderId: string,
  actorUserId: string,
): Promise<WorkOrderCompletionReadiness> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  if (workOrder.status === 'COMPLETED') {
    throw workOrderCompletionAlreadyCompletedError();
  }
  if (workOrder.status !== 'IN_PROGRESS') {
    throw workOrderCompletionInvalidStateError();
  }

  const assignment = await workOrderAssignmentRepository.findActiveByWorkOrderId(
    workOrderId,
  );
  if (!assignment) {
    throw workOrderCompletionNoAssignmentError();
  }
  if (!(await isCompletionActorAuthorized(actorUserId, assignment))) {
    throw workOrderCompletionUnauthorizedError();
  }

  const missingEvidenceTypes = await findMissingRequiredEvidence(workOrderId);
  const requiredEvidenceSatisfied = missingEvidenceTypes.length === 0;

  return {
    workOrderId: workOrder.id,
    status: workOrder.status,
    ready: requiredEvidenceSatisfied,
    requiredEvidenceSatisfied,
    missingEvidenceTypes,
  };
}

/**
 * BE-08H — completes a Work Order (IN_PROGRESS → COMPLETED) after validating
 * readiness and required evidence. Completion is NOT closure — BE-08I owns
 * verification / rework / closure.
 */
export async function completeWorkOrder(
  input: CompleteWorkOrderServiceInput,
): Promise<PublicWorkOrder> {
  const readiness = await validateWorkOrderCompletionReadiness(
    input.workOrderId,
    input.actorUserId,
  );
  if (!readiness.requiredEvidenceSatisfied) {
    throw workOrderCompletionEvidenceIncompleteError(
      readiness.missingEvidenceTypes,
    );
  }

  const record = await withTransaction(async (tx) => {
    const completed = await workOrderRepository.complete(input.workOrderId, {
      completedByUserId: input.actorUserId,
      completionSummary: input.completionSummary?.trim() || null,
      completionNotes: input.completionNotes?.trim() || null,
    }, tx);
    if (completed) await satisfyClock(completed, 'RESOLUTION', completed.completedAt!, tx);
    return completed;
  });
  if (!record) {
    throw workOrderCompletionAlreadyCompletedError();
  }
  await recordWorkOrderEvent({
    workOrderId: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    eventType: 'WORK_ORDER_COMPLETED',
    actorUserId: input.actorUserId,
    summary: `Work order ${record.workOrderNumber} completed`,
    metadata: { workOrderNumber: record.workOrderNumber },
  });
  return toPublicWorkOrder(record);
}

/** Returns the completion subset of a Work Order. */
export async function getWorkOrderCompletion(
  id: string,
): Promise<{
  workOrderId: string;
  status: string;
  completedAt: string | null;
  completedByUserId: string | null;
  completionSummary: string | null;
  completionNotes: string | null;
}> {
  const workOrder = await workOrderRepository.findById(id);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  return {
    workOrderId: workOrder.id,
    status: workOrder.status,
    completedAt: iso(workOrder.completedAt),
    completedByUserId: workOrder.completedByUserId,
    completionSummary: workOrder.completionSummary,
    completionNotes: workOrder.completionNotes,
  };
}

function isWorkOrderNumberUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'work_order_number_unique'
  );
}

export const workOrderService = {
  bindWorkOrderContext,
  completeWorkOrder,
  createWorkOrder,
  createWorkOrderFromRequest,
  getWorkOrderById,
  getWorkOrderCompletion,
  getWorkOrderContext,
  listTeamWorkOrders,
  listWorkOrdersByBuilding,
  toPublicWorkOrder,
  transitionWorkOrderStatus,
  updateWorkOrder,
  updateWorkOrderBastRequirement,
  updateWorkOrderPriority,
  validateWorkOrderCompletionReadiness,
};

