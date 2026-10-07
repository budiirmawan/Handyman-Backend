import {
  vendorAssignmentNotFoundError,
  vendorAssignmentRepository,
} from '../vendor-assignments';
import { vendorBuildingRepository } from '../vendor-buildings';
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
  vendorWorkAssignmentInactiveError,
  vendorWorkBuildingMismatchError,
  vendorWorkInvalidTransitionError,
  vendorWorkNotFoundError,
  vendorWorkWorkOrderInvalidStateError,
} from './vendor-work.errors';
import { vendorWorkRepository } from './vendor-work.repository';
import {
  canTransitionVendorWorkStatus,
  type NewVendorWork,
  type PublicVendorWork,
  type ResolveVendorWorkInput,
  type UpdateVendorWorkStatusInput,
  type VendorWorkFilters,
  type VendorWorkRecord,
} from './vendor-work.types';

export function toPublicVendorWork(record: VendorWorkRecord): PublicVendorWork {
  return {
    id: record.id,
    vendorAssignmentId: record.vendorAssignmentId,
    vendorId: record.vendorId,
    workOrderId: record.workOrderId,
    buildingId: record.buildingId,
    status: record.status,
    notes: record.notes,
    startedAt: record.startedAt ? record.startedAt.toISOString() : null,
    completedAt: record.completedAt ? record.completedAt.toISOString() : null,
  };
}

type WorkableContext = {
  clientId: string;
  workOrderId: string;
  buildingId: string;
  vendorId: string;
};

/**
 * Loads the BE-15A assignment and asserts it can carry work: the assignment
 * must exist and be ACTIVE.
 */
async function loadActiveAssignment(
  vendorAssignmentId: string,
): Promise<{ vendorId: string; workOrderId: string; buildingId: string }> {
  const assignment =
    await vendorAssignmentRepository.findById(vendorAssignmentId);
  if (!assignment) {
    throw vendorAssignmentNotFoundError();
  }
  if (assignment.status !== 'ACTIVE') {
    throw vendorWorkAssignmentInactiveError();
  }
  return {
    vendorId: assignment.vendorId,
    workOrderId: assignment.workOrderId,
    buildingId: assignment.buildingId,
  };
}

/**
 * Validates the BE-08 Work Order and BE-06 Vendor against the assignment's
 * context. The Work Order must still be in an assignable state, and the
 * Vendor must still be ACTIVE and hold an ACTIVE relationship to the Work
 * Order's Building. This re-validation keeps the backend authoritative even
 * if the underlying masters change after assignment.
 */
async function resolveWorkableContext(
  assignment: { vendorId: string; workOrderId: string; buildingId: string },
): Promise<WorkableContext> {
  const workOrder = await workOrderRepository.findById(assignment.workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  if (!isWorkOrderAssignableStatus(workOrder.status)) {
    throw vendorWorkWorkOrderInvalidStateError(workOrder.status);
  }
  if (workOrder.buildingId !== assignment.buildingId) {
    throw vendorWorkBuildingMismatchError();
  }

  const vendor = await vendorRepository.findById(assignment.vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }
  if (vendor.status !== 'ACTIVE') {
    throw vendorInactiveError();
  }
  const relationship = await vendorBuildingRepository.findActiveByVendorAndBuilding(
    vendor.id,
    workOrder.buildingId,
  );
  if (!relationship) {
    throw vendorWorkBuildingMismatchError();
  }

  return {
    clientId: workOrder.clientId,
    workOrderId: workOrder.id,
    buildingId: workOrder.buildingId,
    vendorId: vendor.id,
  };
}

function isAssignmentUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'vendor_works_assignment_unique'
  );
}

/**
 * Resolves (creates or fetches) the Vendor Work context for a BE-15A
 * assignment. The first call creates a NOT_STARTED record; later calls
 * return the existing record (idempotent — one work record per assignment).
 */
export async function resolveVendorWork(
  vendorAssignmentId: string,
  input: ResolveVendorWorkInput = {},
): Promise<{ work: PublicVendorWork; created: boolean }> {
  const assignment = await loadActiveAssignment(vendorAssignmentId);
  const context = await resolveWorkableContext(assignment);

  const existing =
    await vendorWorkRepository.findByAssignmentId(vendorAssignmentId);
  if (existing) {
    return { work: toPublicVendorWork(existing), created: false };
  }

  const newWork: NewVendorWork = {
    vendorAssignmentId,
    vendorId: context.vendorId,
    workOrderId: context.workOrderId,
    buildingId: context.buildingId,
    notes: input.notes ?? null,
  };

  try {
    const record = await vendorWorkRepository.create(newWork);
    await recordOperationalEvent({
      clientId: context.clientId,
      eventType: 'VENDOR_WORK_CREATED',
      entityType: 'VENDOR_WORK',
      entityId: record.id,
      actorUserId: null,
      buildingId: context.buildingId,
      vendorWorkId: record.id,
      summary: 'Vendor work created',
      metadata: {
        vendorId: record.vendorId,
        workOrderId: record.workOrderId,
        vendorAssignmentId: record.vendorAssignmentId,
      },
    });
    return { work: toPublicVendorWork(record), created: true };
  } catch (error) {
    // The UNIQUE constraint is the final authority for resolve races.
    if (isAssignmentUniqueViolation(error)) {
      const raced =
        await vendorWorkRepository.findByAssignmentId(vendorAssignmentId);
      if (raced) {
        return { work: toPublicVendorWork(raced), created: false };
      }
    }
    throw error;
  }
}

/** Returns one Vendor Work record by id. */
export async function getVendorWork(workId: string): Promise<PublicVendorWork> {
  const record = await vendorWorkRepository.findById(workId);
  if (!record) {
    throw vendorWorkNotFoundError();
  }
  return toPublicVendorWork(record);
}

/**
 * Lists Vendor Work scoped to the caller's accessible Building set, narrowed
 * by Vendor / Building / status. When both a Vendor and a Building filter are
 * supplied, the Vendor must hold an ACTIVE relationship to that Building.
 */
export async function listVendorWorks(
  filters: VendorWorkFilters,
  accessibleBuildingIds: string[],
): Promise<PublicVendorWork[]> {
  if (filters.vendorId && filters.buildingId) {
    const relationship =
      await vendorBuildingRepository.findActiveByVendorAndBuilding(
        filters.vendorId,
        filters.buildingId,
      );
    if (!relationship) {
      throw vendorWorkBuildingMismatchError();
    }
  }

  const buildingIds =
    filters.buildingId !== undefined
      ? [filters.buildingId]
      : accessibleBuildingIds;

  if (buildingIds.length === 0) {
    return [];
  }

  const records = await vendorWorkRepository.list({
    vendorId: filters.vendorId,
    buildingId: filters.buildingId,
    status: filters.status,
    buildingIds,
  });
  return records.map(toPublicVendorWork);
}

/**
 * Applies a lifecycle transition (NOT_STARTED → IN_PROGRESS → ON_HOLD →
 * COMPLETED, resume ON_HOLD → IN_PROGRESS). The allowed transitions are
 * driven by the explicit `VENDOR_WORK_TRANSITIONS` table — no generic engine.
 * `started_at` is set the first time work leaves NOT_STARTED; `completed_at`
 * is set when work reaches COMPLETED. COMPLETED is terminal for BE-15B.
 */
export async function transitionVendorWorkStatus(
  workId: string,
  input: UpdateVendorWorkStatusInput,
): Promise<PublicVendorWork> {
  const existing = await vendorWorkRepository.findById(workId);
  if (!existing) {
    throw vendorWorkNotFoundError();
  }

  if (!canTransitionVendorWorkStatus(existing.status, input.status)) {
    throw vendorWorkInvalidTransitionError(existing.status, input.status);
  }

  const startedAt =
    existing.startedAt === null ? new Date() : existing.startedAt;
  const completedAt =
    input.status === 'COMPLETED' ? new Date() : existing.completedAt;

  const record = await vendorWorkRepository.update(workId, {
    status: input.status,
    startedAt,
    completedAt,
    ...(input.notes === undefined ? {} : { notes: input.notes ?? null }),
  });

  const workOrder = await workOrderRepository.findById(existing.workOrderId);
  if (workOrder) {
    await recordOperationalEvent({
      clientId: workOrder.clientId,
      eventType: 'VENDOR_WORK_STATUS_CHANGED',
      entityType: 'VENDOR_WORK',
      entityId: workId,
      actorUserId: null,
      buildingId: workOrder.buildingId,
      vendorWorkId: workId,
      summary: `Vendor work status changed from ${existing.status} to ${input.status}`,
      metadata: { from: existing.status, to: input.status },
    });
  }

  return toPublicVendorWork(record as VendorWorkRecord);
}

export const vendorWorkService = {
  getVendorWork,
  listVendorWorks,
  resolveVendorWork,
  toPublicVendorWork,
  transitionVendorWorkStatus,
};
