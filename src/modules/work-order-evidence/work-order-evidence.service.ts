import { workOrderAssignmentRepository } from '../work-order-assignments';
import type { WorkOrderAssignmentRecord } from '../work-order-assignments';
import { vendorWorkforceRepository } from '../vendor-workforce';
import { workforceRepository } from '../workforce';
import {
  workOrderNotFoundError,
  workOrderRepository,
  type WorkOrderRecord,
} from '../work-orders';
import { recordWorkOrderEvent } from '../work-order-history';
import {
  workOrderEvidenceCountViolationError,
  workOrderEvidenceInvalidStateError,
  workOrderEvidenceNoAssignmentError,
  workOrderEvidenceNotFoundError,
  workOrderEvidenceRequirementMismatchError,
  workOrderEvidenceUnauthorizedError,
} from './work-order-evidence.errors';
import { workOrderEvidenceRepository } from './work-order-evidence.repository';
import type {
  PublicWorkOrderEvidence,
  PublicWorkOrderEvidenceRequirement,
  SubmitWorkOrderEvidenceInput,
} from './work-order-evidence.types';
import { applyRetentionToEvidence } from '../evidence-retention-policies/evidence-retention-application.service';

/** Work Order states that may still receive evidence. */
const EVIDENCE_ACTIVE_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];

const ALLOWED_MIME: Record<string, readonly string[]> = {
  PHOTO: ['image/jpeg', 'image/png', 'image/webp'],
  DOCUMENT: ['application/pdf', 'image/jpeg', 'image/png'],
  SIGNATURE: ['image/png', 'image/svg+xml'],
};

async function loadWorkOrder(workOrderId: string): Promise<WorkOrderRecord> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  return workOrder;
}

/**
 * Returns true when the acting user is the assignee (or a member of the
 * assigned team / bound to the assigned vendor) of the active assignment —
 * the same authorization rule BE-08F uses for execution actions.
 */
async function isActorAuthorized(
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
 * Lists the ACTIVE BE-07 evidence requirements bound to a Work Order
 * (`target_type = 'WORK_ORDER'`).
 */
export async function listWorkOrderEvidenceRequirements(
  workOrderId: string,
): Promise<PublicWorkOrderEvidenceRequirement[]> {
  await loadWorkOrder(workOrderId);
  return workOrderEvidenceRepository.listRequirementsForWorkOrder(workOrderId);
}

/**
 * Binds a PHOTO / DOCUMENT / SIGNATURE submission to a Work Order through the
 * BE-07 evidence engine.
 *
 * Validation order (pinned by tests):
 *   1. unknown Work Order          → 404 WORK_ORDER_NOT_FOUND
 *   2. terminal / inactive state   → 400 WORK_ORDER_EVIDENCE_INVALID_STATE
 *   3. no active assignment        → 400 WORK_ORDER_EVIDENCE_NO_ASSIGNMENT
 *   4. actor not authorized        → 403 WORK_ORDER_EVIDENCE_UNAUTHORIZED
 *   5. unknown / mismatched requirement → 400 WORK_ORDER_EVIDENCE_REQUIREMENT_MISMATCH
 *   6. MIME mismatch               → 400 WORK_ORDER_EVIDENCE_REQUIREMENT_MISMATCH
 *   7. max-count exceeded          → 400 WORK_ORDER_EVIDENCE_COUNT_VIOLATION
 */
export async function submitWorkOrderEvidence(
  input: SubmitWorkOrderEvidenceInput,
): Promise<PublicWorkOrderEvidence> {
  const workOrder = await loadWorkOrder(input.workOrderId);

  if (
    !(EVIDENCE_ACTIVE_STATUSES as readonly string[]).includes(workOrder.status)
  ) {
    throw workOrderEvidenceInvalidStateError();
  }

  const assignment = await workOrderAssignmentRepository.findActiveByWorkOrderId(
    input.workOrderId,
  );
  if (!assignment) {
    throw workOrderEvidenceNoAssignmentError();
  }
  if (!(await isActorAuthorized(input.submittedByUserId, assignment))) {
    throw workOrderEvidenceUnauthorizedError();
  }

  let requirement: PublicWorkOrderEvidenceRequirement | null = null;
  if (input.evidenceRequirementId !== undefined) {
    requirement =
      await workOrderEvidenceRepository.findRequirementByIdForWorkOrder(
        input.workOrderId,
        input.evidenceRequirementId,
      );
    if (!requirement) {
      throw workOrderEvidenceRequirementMismatchError();
    }
    if (requirement.evidenceType !== input.evidenceType) {
      throw workOrderEvidenceRequirementMismatchError();
    }
  }

  const allowed = ALLOWED_MIME[input.evidenceType];
  if (!allowed || !allowed.includes(input.mimeType)) {
    throw workOrderEvidenceRequirementMismatchError();
  }

  if (requirement && requirement.maximumCount !== null) {
    const count =
      await workOrderEvidenceRepository.countActiveSubmissionsForRequirement(
        requirement.id,
      );
    if (count >= requirement.maximumCount) {
      throw workOrderEvidenceCountViolationError();
    }
  }

  const evidence = await workOrderEvidenceRepository.createSubmission({
    ...input,
    clientId: workOrder.clientId,
  });
  // CR-BE-DOC-CONTROL-01 PART 03 — attach retention governance at creation.
  await applyRetentionToEvidence(String(evidence.id), input.submittedByUserId);
  await recordWorkOrderEvent({
    workOrderId: workOrder.id,
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
    eventType: 'WORK_ORDER_EVIDENCE_ADDED',
    actorUserId: input.submittedByUserId,
    summary: `Work order evidence added (${input.evidenceType})`,
    metadata: { evidenceType: input.evidenceType },
  });
  return evidence;
}

/** Lists the ACTIVE evidence submissions bound to a Work Order. */
export async function listWorkOrderEvidence(
  workOrderId: string,
): Promise<PublicWorkOrderEvidence[]> {
  await loadWorkOrder(workOrderId);
  return workOrderEvidenceRepository.listSubmissionsForWorkOrder(workOrderId);
}

/**
 * Removes (soft-deactivates) a Work Order evidence submission, following the
 * BE-07 remove rule (`status → 'REMOVED'`). The submission must belong to the
 * addressed Work Order.
 */
export async function removeWorkOrderEvidence(
  workOrderId: string,
  evidenceId: string,
): Promise<PublicWorkOrderEvidence> {
  await loadWorkOrder(workOrderId);
  const existing = await workOrderEvidenceRepository.findSubmissionById(
    evidenceId,
  );
  if (!existing || existing.workOrderId !== workOrderId) {
    throw workOrderEvidenceNotFoundError();
  }
  const removed = await workOrderEvidenceRepository.removeSubmission(evidenceId);
  if (!removed) {
    throw workOrderEvidenceNotFoundError();
  }
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (workOrder) {
    await recordWorkOrderEvent({
      workOrderId,
      clientId: workOrder.clientId,
      buildingId: workOrder.buildingId,
      eventType: 'WORK_ORDER_EVIDENCE_REMOVED',
      summary: 'Work order evidence removed',
      metadata: { evidenceType: removed.evidenceType },
    });
  }
  return removed;
}

export const workOrderEvidenceService = {
  listWorkOrderEvidence,
  listWorkOrderEvidenceRequirements,
  removeWorkOrderEvidence,
  submitWorkOrderEvidence,
};
