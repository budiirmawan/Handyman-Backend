import {
  vendorBuildingRepository,
} from '../vendor-buildings';
import {
  vendorInactiveError,
  vendorNotFoundError,
  vendorRepository,
} from '../vendors';
import { recordOperationalEvent } from '../operational-events';
import { isWorkOrderAssignableStatus } from '../work-order-assignments';
import {
  workOrderNotFoundError,
  workOrderRepository,
} from '../work-orders';
import {
  vendorAssignmentAlreadyActiveError,
  vendorAssignmentBuildingMismatchError,
  vendorAssignmentClientMismatchError,
  vendorAssignmentNotActiveError,
  vendorAssignmentNotFoundError,
  vendorAssignmentWorkOrderInvalidStateError,
} from './vendor-assignment.errors';
import { vendorAssignmentRepository } from './vendor-assignment.repository';
import type {
  AssignVendorAssignmentInput,
  NewVendorAssignment,
  PublicVendorAssignment,
  VendorAssignmentFilters,
  VendorAssignmentRecord,
} from './vendor-assignment.types';

export function toPublicVendorAssignment(
  record: VendorAssignmentRecord,
): PublicVendorAssignment {
  return {
    id: record.id,
    vendorId: record.vendorId,
    workOrderId: record.workOrderId,
    buildingId: record.buildingId,
    status: record.status,
    notes: record.notes,
    assignedByUserId: record.assignedByUserId,
    assignedAt: record.assignedAt.toISOString(),
  };
}

type AssignableWorkOrder = {
  id: string;
  clientId: string;
  buildingId: string;
  status: string;
};

/** Loads a Work Order and asserts it is in an assignable lifecycle state. */
async function loadAssignableWorkOrder(
  workOrderId: string,
): Promise<AssignableWorkOrder> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  if (!isWorkOrderAssignableStatus(workOrder.status)) {
    throw vendorAssignmentWorkOrderInvalidStateError(workOrder.status);
  }
  return {
    id: workOrder.id,
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
    status: workOrder.status,
  };
}

/**
 * Validates a Vendor against the Work Order's context and resolves it into
 * persistence-ready assignment fields. The Vendor must exist, be ACTIVE,
 * belong to the Work Order's Client, and hold an ACTIVE Vendor ↔ Building
 * relationship to the Work Order's Building (BE-06D).
 */
async function resolveVendorAssignment(
  workOrder: AssignableWorkOrder,
  input: AssignVendorAssignmentInput,
): Promise<NewVendorAssignment> {
  const vendor = await vendorRepository.findById(input.vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }
  if (vendor.status !== 'ACTIVE') {
    throw vendorInactiveError();
  }
  if (vendor.clientId !== workOrder.clientId) {
    throw vendorAssignmentClientMismatchError();
  }
  const relationship = await vendorBuildingRepository.findActiveByVendorAndBuilding(
    vendor.id,
    workOrder.buildingId,
  );
  if (!relationship) {
    throw vendorAssignmentBuildingMismatchError();
  }

  return {
    vendorId: vendor.id,
    workOrderId: workOrder.id,
    buildingId: workOrder.buildingId,
    notes: input.notes ?? null,
    assignedByUserId: input.assignedByUserId,
  };
}

function isActiveAssignmentUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'vendor_assignments_active_unique'
  );
}

/**
 * Assigns a Vendor to a Work Order. The Work Order must be in an assignable
 * state; the Vendor must be valid/active for the Work Order's Building. A
 * Vendor already holding an ACTIVE assignment for the same Work Order is
 * rejected (409) — it must be reassigned or deactivated first.
 */
export async function assignVendor(
  input: AssignVendorAssignmentInput,
): Promise<PublicVendorAssignment> {
  const workOrder = await loadAssignableWorkOrder(input.workOrderId);

  const existing =
    await vendorAssignmentRepository.findActiveByVendorAndWorkOrder(
      input.vendorId,
      input.workOrderId,
    );
  if (existing) {
    throw vendorAssignmentAlreadyActiveError();
  }

  const resolved = await resolveVendorAssignment(workOrder, input);
  try {
    const record = await vendorAssignmentRepository.create(resolved);
    await recordOperationalEvent({
      clientId: workOrder.clientId,
      eventType: 'VENDOR_ASSIGNMENT_CREATED',
      entityType: 'VENDOR_ASSIGNMENT',
      entityId: record.id,
      actorUserId: input.assignedByUserId,
      buildingId: workOrder.buildingId,
      summary: 'Vendor assigned to work order',
      metadata: {
        vendorId: record.vendorId,
        workOrderId: record.workOrderId,
        vendorAssignmentId: record.id,
      },
    });
    return toPublicVendorAssignment(record);
  } catch (error) {
    // The partial ACTIVE unique index is the final authority for races.
    if (isActiveAssignmentUniqueViolation(error)) {
      throw vendorAssignmentAlreadyActiveError();
    }
    throw error;
  }
}

/** Returns one assignment by id. */
export async function getVendorAssignment(
  assignmentId: string,
): Promise<PublicVendorAssignment> {
  const record = await vendorAssignmentRepository.findById(assignmentId);
  if (!record) {
    throw vendorAssignmentNotFoundError();
  }
  return toPublicVendorAssignment(record);
}

/**
 * Lists assignments scoped to the caller's accessible Building set (resolved
 * by the controller via BE-02G), optionally narrowed by Vendor / Work Order /
 * Building. At least one filter is required by validation.
 */
export async function listVendorAssignments(
  filters: VendorAssignmentFilters,
  accessibleBuildingIds: string[],
): Promise<PublicVendorAssignment[]> {
  const buildingIds =
    filters.buildingId !== undefined
      ? [filters.buildingId]
      : accessibleBuildingIds;

  if (buildingIds.length === 0) {
    return [];
  }

  const records = await vendorAssignmentRepository.list({
    vendorId: filters.vendorId,
    workOrderId: filters.workOrderId,
    buildingIds,
  });
  return records.map(toPublicVendorAssignment);
}

/**
 * Deactivates an assignment (it is never deleted — history is preserved).
 * Re-deactivating an already-INACTIVE assignment is a no-op success.
 */
export async function deactivateVendorAssignment(
  assignmentId: string,
): Promise<PublicVendorAssignment> {
  const record = await vendorAssignmentRepository.findById(assignmentId);
  if (!record) {
    throw vendorAssignmentNotFoundError();
  }
  const updated = await vendorAssignmentRepository.updateStatus(
    assignmentId,
    'INACTIVE',
  );
  const workOrder = await workOrderRepository.findById(record.workOrderId);
  if (workOrder) {
    await recordOperationalEvent({
      clientId: workOrder.clientId,
      eventType: 'VENDOR_ASSIGNMENT_DEACTIVATED',
      entityType: 'VENDOR_ASSIGNMENT',
      entityId: record.id,
      actorUserId: null,
      buildingId: record.buildingId,
      summary: 'Vendor assignment deactivated',
      metadata: {
        vendorId: record.vendorId,
        workOrderId: record.workOrderId,
        vendorAssignmentId: record.id,
      },
    });
  }
  return toPublicVendorAssignment(updated as VendorAssignmentRecord);
}

/**
 * Reassigns an assignment: deactivates the current ACTIVE assignment and
 * creates a fresh one from the supplied Vendor / Work Order / notes. The
 * target must be ACTIVE, and the new combination is validated with the same
 * rules as a new assignment.
 */
export async function reassignVendorAssignment(
  assignmentId: string,
  input: AssignVendorAssignmentInput,
): Promise<PublicVendorAssignment> {
  const record = await vendorAssignmentRepository.findById(assignmentId);
  if (!record) {
    throw vendorAssignmentNotFoundError();
  }
  if (record.status !== 'ACTIVE') {
    throw vendorAssignmentNotActiveError();
  }

  const workOrder = await loadAssignableWorkOrder(input.workOrderId);
  const resolved = await resolveVendorAssignment(workOrder, input);

  await vendorAssignmentRepository.updateStatus(assignmentId, 'INACTIVE');

  try {
    const created = await vendorAssignmentRepository.create(resolved);
    await recordOperationalEvent({
      clientId: workOrder.clientId,
      eventType: 'VENDOR_ASSIGNMENT_REASSIGNED',
      entityType: 'VENDOR_ASSIGNMENT',
      entityId: created.id,
      actorUserId: input.assignedByUserId,
      buildingId: workOrder.buildingId,
      summary: 'Vendor assignment reassigned',
      metadata: {
        vendorId: created.vendorId,
        workOrderId: created.workOrderId,
        vendorAssignmentId: created.id,
        previousAssignmentId: record.id,
      },
    });
    return toPublicVendorAssignment(created);
  } catch (error) {
    if (isActiveAssignmentUniqueViolation(error)) {
      throw vendorAssignmentAlreadyActiveError();
    }
    throw error;
  }
}

export const vendorAssignmentService = {
  assignVendor,
  deactivateVendorAssignment,
  getVendorAssignment,
  listVendorAssignments,
  reassignVendorAssignment,
  toPublicVendorAssignment,
};
