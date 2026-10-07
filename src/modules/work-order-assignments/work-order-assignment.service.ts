import {
  teamInactiveError,
  teamNotFoundError,
  teamRepository,
} from '../teams';
import {
  vendorInactiveError,
  vendorNotFoundError,
  vendorRepository,
} from '../vendors';
import {
  vendorWorkforceRepository,
} from '../vendor-workforce';
import {
  workOrderNotFoundError,
  workOrderRepository,
} from '../work-orders';
import { recordWorkOrderEvent } from '../work-order-history';
import {
  workforceProfileInactiveError,
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import { departmentRepository } from '../departments';
import { organizationRepository } from '../organizations';
import { workforceBuildingAssignmentRepository } from '../workforce-building-assignments';
import { vendorBuildingRepository } from '../vendor-buildings';
import {
  workOrderAssignmentAlreadyAssignedError,
  workOrderAssignmentBuildingMismatchError,
  workOrderAssignmentClientMismatchError,
  workOrderAssignmentInvalidStateError,
  workOrderAssignmentNotFoundError,
  workOrderAssignmentVendorWorkforceMismatchError,
} from './work-order-assignment.errors';
import { workOrderAssignmentRepository } from './work-order-assignment.repository';
import {
  isWorkOrderAssignableStatus,
  type AssignWorkOrderInput,
  type NewWorkOrderAssignment,
  type PublicWorkOrderAssignment,
  type UpdateWorkOrderAssignmentInput,
  type WorkOrderAssignmentRecord,
} from './work-order-assignment.types';

export function toPublicWorkOrderAssignment(
  record: WorkOrderAssignmentRecord,
): PublicWorkOrderAssignment {
  return {
    id: record.id,
    workOrderId: record.workOrderId,
    assigneeType: record.assigneeType,
    workforceProfileId: record.workforceProfileId,
    teamId: record.teamId,
    vendorId: record.vendorId,
    assignedByUserId: record.assignedByUserId,
    assignedAt: record.assignedAt.toISOString(),
    status: record.status,
  };
}

/** Resolves the Client that owns a Workforce Profile (Profile → Org → Client). */
async function resolveWorkforceClient(
  workforceProfileId: string,
): Promise<string> {
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile) {
    throw workforceProfileNotFoundError();
  }
  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    throw workforceProfileNotFoundError();
  }
  return organization.clientId;
}

/** Resolves the Client that owns a Team (Team → Dept → Org → Client). */
async function resolveTeamClient(teamId: string): Promise<string> {
  const team = await teamRepository.findById(teamId);
  if (!team) {
    throw teamNotFoundError();
  }
  const department = await departmentRepository.findById(team.departmentId);
  if (!department) {
    throw teamNotFoundError();
  }
  const organization = await organizationRepository.findById(
    department.organizationId,
  );
  if (!organization) {
    throw teamNotFoundError();
  }
  return organization.clientId;
}

/**
 * Validates a WORKFORCE assignment: the profile must exist, be ACTIVE, belong
 * to the Work Order's Client, and be placed (operational assignment) in the
 * Work Order's Building.
 */
async function validateWorkforce(
  workOrder: { clientId: string; buildingId: string },
  workforceProfileId: string,
): Promise<void> {
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile) {
    throw workforceProfileNotFoundError();
  }
  if (profile.status !== 'ACTIVE') {
    throw workforceProfileInactiveError();
  }
  const profileClientId = await resolveWorkforceClient(workforceProfileId);
  if (profileClientId !== workOrder.clientId) {
    throw workOrderAssignmentClientMismatchError();
  }
  const placement =
    await workforceBuildingAssignmentRepository.findActiveByProfileAndBuilding(
      workforceProfileId,
      workOrder.buildingId,
    );
  if (!placement) {
    throw workOrderAssignmentBuildingMismatchError();
  }
}

/**
 * Validates a TEAM assignment: the team must exist, be ACTIVE, and belong to
 * the Work Order's Client. Teams are organization-grouping concepts, not
 * Building-scoped, so no building placement is required.
 */
async function validateTeam(
  workOrder: { clientId: string },
  teamId: string,
): Promise<void> {
  const team = await teamRepository.findById(teamId);
  if (!team) {
    throw teamNotFoundError();
  }
  if (team.status !== 'ACTIVE') {
    throw teamInactiveError();
  }
  const teamClientId = await resolveTeamClient(teamId);
  if (teamClientId !== workOrder.clientId) {
    throw workOrderAssignmentClientMismatchError();
  }
}

/**
 * Validates a VENDOR assignment: the vendor must exist, be ACTIVE, belong to
 * the Work Order's Client, and hold an ACTIVE relationship to the Work
 * Order's Building.
 */
async function validateVendor(
  workOrder: { clientId: string; buildingId: string },
  vendorId: string,
): Promise<void> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }
  if (vendor.status !== 'ACTIVE') {
    throw vendorInactiveError();
  }
  if (vendor.clientId !== workOrder.clientId) {
    throw workOrderAssignmentClientMismatchError();
  }
  const relationship = await vendorBuildingRepository.findActiveByVendorAndBuilding(
    vendorId,
    workOrder.buildingId,
  );
  if (!relationship) {
    throw workOrderAssignmentBuildingMismatchError();
  }
}

/**
 * Validates a VENDOR_WORKFORCE assignment: the vendor must exist, be ACTIVE,
 * belong to the Work Order's Client, hold an ACTIVE relationship to the Work
 * Order's Building, and the Workforce Profile must be bound to that Vendor.
 */
async function validateVendorWorkforce(
  workOrder: { clientId: string; buildingId: string },
  vendorId: string,
  workforceProfileId: string,
): Promise<void> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }
  if (vendor.status !== 'ACTIVE') {
    throw vendorInactiveError();
  }
  if (vendor.clientId !== workOrder.clientId) {
    throw workOrderAssignmentClientMismatchError();
  }
  const relationship = await vendorBuildingRepository.findActiveByVendorAndBuilding(
    vendorId,
    workOrder.buildingId,
  );
  if (!relationship) {
    throw workOrderAssignmentBuildingMismatchError();
  }
  const binding = await vendorWorkforceRepository.findByVendorAndWorkforce(
    vendorId,
    workforceProfileId,
  );
  if (!binding || binding.status !== 'ACTIVE') {
    throw workOrderAssignmentVendorWorkforceMismatchError();
  }
}

/**
 * Validates an assignee payload against the Work Order's Client/Building
 * context and resolves it into persistence-ready fields.
 */
async function resolveAssignee(
  workOrder: { clientId: string; buildingId: string },
  input: AssignWorkOrderInput,
): Promise<NewWorkOrderAssignment> {
  const base = {
    workOrderId: input.workOrderId,
    assignedByUserId: input.assignedByUserId,
  };

  switch (input.assigneeType) {
    case 'WORKFORCE': {
      const workforceProfileId = requireId(input.workforceProfileId);
      await validateWorkforce(workOrder, workforceProfileId);
      return {
        ...base,
        assigneeType: input.assigneeType,
        workforceProfileId,
        teamId: null,
        vendorId: null,
      };
    }
    case 'TEAM': {
      const teamId = requireId(input.teamId);
      await validateTeam(workOrder, teamId);
      return {
        ...base,
        assigneeType: input.assigneeType,
        workforceProfileId: null,
        teamId,
        vendorId: null,
      };
    }
    case 'VENDOR': {
      const vendorId = requireId(input.vendorId);
      await validateVendor(workOrder, vendorId);
      return {
        ...base,
        assigneeType: input.assigneeType,
        workforceProfileId: null,
        teamId: null,
        vendorId,
      };
    }
    case 'VENDOR_WORKFORCE': {
      const vendorId = requireId(input.vendorId);
      const workforceProfileId = requireId(input.workforceProfileId);
      await validateVendorWorkforce(workOrder, vendorId, workforceProfileId);
      return {
        ...base,
        assigneeType: input.assigneeType,
        workforceProfileId,
        teamId: null,
        vendorId,
      };
    }
  }
}

function requireId(value: string | undefined): string {
  if (!value) {
    // Validation guarantees presence per assignee type before reaching here.
    throw workOrderAssignmentVendorWorkforceMismatchError();
  }
  return value;
}

async function loadAssignableWorkOrder(
  workOrderId: string,
): Promise<{ clientId: string; buildingId: string; status: string }> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  if (!isWorkOrderAssignableStatus(workOrder.status)) {
    throw workOrderAssignmentInvalidStateError(workOrder.status);
  }
  return {
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
    status: workOrder.status,
  };
}

/**
 * Assigns a Work Order to a Workforce / Team / Vendor / Vendor Workforce.
 * The Work Order must be in an assignable lifecycle state, and the assignee
 * must resolve to the same Client (and, where applicable, Building) context.
 * A Work Order with an existing ACTIVE assignment is rejected (409) — it must
 * be reassigned through the dedicated reassign flow.
 */
export async function assignWorkOrder(
  input: AssignWorkOrderInput,
): Promise<PublicWorkOrderAssignment> {
  const workOrder = await loadAssignableWorkOrder(input.workOrderId);

  const existing = await workOrderAssignmentRepository.findActiveByWorkOrderId(
    input.workOrderId,
  );
  if (existing) {
    throw workOrderAssignmentAlreadyAssignedError();
  }

  const newAssignment = await resolveAssignee(workOrder, input);
  try {
    const record = await workOrderAssignmentRepository.create(newAssignment);
    await recordWorkOrderEvent({
      workOrderId: input.workOrderId,
      clientId: workOrder.clientId,
      buildingId: workOrder.buildingId,
      eventType: 'WORK_ORDER_ASSIGNED',
      actorUserId: input.assignedByUserId,
      summary: `Work order assigned to ${input.assigneeType}`,
      metadata: { assigneeType: input.assigneeType },
    });
    return toPublicWorkOrderAssignment(record);
  } catch (error) {
    // The partial ACTIVE unique index is the final authority for races.
    if (isActiveAssignmentUniqueViolation(error)) {
      throw workOrderAssignmentAlreadyAssignedError();
    }
    throw error;
  }
}

/** Returns the current ACTIVE assignment, or null if none exists. */
export async function getCurrentWorkOrderAssignment(
  workOrderId: string,
): Promise<PublicWorkOrderAssignment | null> {
  const record = await workOrderAssignmentRepository.findActiveByWorkOrderId(
    workOrderId,
  );
  return record ? toPublicWorkOrderAssignment(record) : null;
}

/** Lists all (active + historical) assignments of a Work Order. */
export async function listWorkOrderAssignments(
  workOrderId: string,
): Promise<PublicWorkOrderAssignment[]> {
  const records = await workOrderAssignmentRepository.listByWorkOrderId(
    workOrderId,
  );
  return records.map(toPublicWorkOrderAssignment);
}

/**
 * Deactivates an ACTIVE assignment (it is never deleted — history is kept).
 * Re-deactivating an already-INACTIVE assignment is a no-op success.
 */
export async function deactivateWorkOrderAssignment(
  workOrderId: string,
  assignmentId: string,
): Promise<PublicWorkOrderAssignment> {
  const record = await workOrderAssignmentRepository.findById(assignmentId);
  if (!record) {
    throw workOrderAssignmentNotFoundError();
  }
  if (record.workOrderId !== workOrderId) {
    throw workOrderAssignmentNotFoundError();
  }
  const updated = await workOrderAssignmentRepository.updateStatus(
    assignmentId,
    'INACTIVE',
  );
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (workOrder) {
    await recordWorkOrderEvent({
      workOrderId,
      clientId: workOrder.clientId,
      buildingId: workOrder.buildingId,
      eventType: 'WORK_ORDER_ASSIGNMENT_DEACTIVATED',
      summary: 'Work order assignment deactivated',
      metadata: { assigneeType: record.assigneeType },
    });
  }
  return toPublicWorkOrderAssignment(updated as WorkOrderAssignmentRecord);
}

/**
 * Reassigns a Work Order: deactivates its current ACTIVE assignment (if any)
 * and assigns the new assignee. Reusing the assignee validation, this keeps
 * one active assignment invariant intact.
 */
export async function reassignWorkOrder(
  workOrderId: string,
  input: AssignWorkOrderInput,
): Promise<PublicWorkOrderAssignment> {
  const workOrder = await loadAssignableWorkOrder(workOrderId);

  const newAssignment = await resolveAssignee(workOrder, {
    ...input,
    workOrderId,
  });

  const current = await workOrderAssignmentRepository.findActiveByWorkOrderId(
    workOrderId,
  );
  if (current) {
    await workOrderAssignmentRepository.updateStatus(current.id, 'INACTIVE');
  }

  try {
    const record = await workOrderAssignmentRepository.create(newAssignment);
    await recordWorkOrderEvent({
      workOrderId,
      clientId: workOrder.clientId,
      buildingId: workOrder.buildingId,
      eventType: 'WORK_ORDER_REASSIGNED',
      actorUserId: input.assignedByUserId,
      summary: `Work order reassigned to ${input.assigneeType}`,
      metadata: { assigneeType: input.assigneeType },
    });
    return toPublicWorkOrderAssignment(record);
  } catch (error) {
    if (isActiveAssignmentUniqueViolation(error)) {
      // Extremely unlikely (we just deactivated); surface as already assigned.
      throw workOrderAssignmentAlreadyAssignedError();
    }
    throw error;
  }
}

function isActiveAssignmentUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'work_order_active_assignment_unique'
  );
}

export const workOrderAssignmentService = {
  assignWorkOrder,
  deactivateWorkOrderAssignment,
  getCurrentWorkOrderAssignment,
  listWorkOrderAssignments,
  reassignWorkOrder,
  toPublicWorkOrderAssignment,
};
