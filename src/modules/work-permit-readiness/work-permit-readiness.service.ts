import { AppError } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { vendorBuildingRepository } from '../vendor-buildings';
import {
  vendorWorkNotFoundError,
  vendorWorkRepository,
} from '../vendor-work';
import {
  workOrderNotFoundError,
  workOrderRepository,
} from '../work-orders';
import {
  permitReadinessAlreadyExistsError,
  permitReadinessBuildingMismatchError,
  permitReadinessInvalidValidityError,
  permitReadinessNotFoundError,
} from './work-permit-readiness.errors';
import { workPermitReadinessRepository } from './work-permit-readiness.repository';
import {
  NOT_REQUIRED_TYPE,
  type CreateWorkPermitReadinessInput,
  type NewWorkPermitReadiness,
  type PermitReadinessStatus,
  type PermitStatus,
  type PublicWorkPermitReadiness,
  type ResolvedPermitReadiness,
  type UpdateWorkPermitReadinessInput,
  type VendorWorkPermitReadiness,
  type WorkPermitReadinessFilters,
  type WorkPermitReadinessRecord,
} from './work-permit-readiness.types';

/**
 * BE-15D — Work Permit Readiness service.
 *
 * A readiness/binding layer only: it records permit-readiness for a BE-15B
 * Vendor Work and derives the readiness status backend-side. No Permit-to-Work
 * engine is built here.
 *
 * Readiness derivation (backend-authoritative, never trusted from clients):
 *   NOT_REQUIRED type              → NOT_REQUIRED
 *   permit_status = EXPIRED        → EXPIRED
 *   permit_status != ISSUED        → NOT_READY
 *   valid_from in the future       → NOT_READY
 *   valid_until in the past        → EXPIRED
 *   otherwise                      → READY
 */
export function deriveReadinessStatus(input: {
  permitRequirementType: string;
  permitStatus: PermitStatus;
  validFrom: Date | null;
  validUntil: Date | null;
  now?: Date;
}): PermitReadinessStatus {
  const now = input.now ?? new Date();
  if (input.permitRequirementType === NOT_REQUIRED_TYPE) {
    return 'NOT_REQUIRED';
  }
  if (input.permitStatus === 'EXPIRED') {
    return 'EXPIRED';
  }
  if (input.permitStatus !== 'ISSUED') {
    return 'NOT_READY';
  }
  if (input.validFrom && input.validFrom.getTime() > now.getTime()) {
    return 'NOT_READY';
  }
  if (input.validUntil && input.validUntil.getTime() <= now.getTime()) {
    return 'EXPIRED';
  }
  return 'READY';
}

/** Aggregates per-permit readiness into the work's overall readiness. */
function aggregateReadiness(
  statuses: PermitReadinessStatus[],
): PermitReadinessStatus {
  if (statuses.length === 0) {
    return 'NOT_REQUIRED';
  }
  if (statuses.includes('EXPIRED')) {
    return 'EXPIRED';
  }
  if (statuses.includes('NOT_READY')) {
    return 'NOT_READY';
  }
  if (statuses.every((status) => status === 'NOT_REQUIRED')) {
    return 'NOT_REQUIRED';
  }
  return 'READY';
}

export function toPublicWorkPermitReadiness(
  record: WorkPermitReadinessRecord,
): PublicWorkPermitReadiness {
  return {
    id: record.id,
    clientId: record.clientId,
    vendorWorkId: record.vendorWorkId,
    buildingId: record.buildingId,
    workOrderId: record.workOrderId,
    permitRequirementType: record.permitRequirementType,
    permitReference: record.permitReference,
    permitStatus: record.permitStatus,
    validFrom: record.validFrom ? record.validFrom.toISOString() : null,
    validUntil: record.validUntil ? record.validUntil.toISOString() : null,
    readinessStatus: record.readinessStatus,
    notes: record.notes,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toResolvedPermitReadiness(
  record: WorkPermitReadinessRecord,
  now: Date,
): ResolvedPermitReadiness {
  return {
    id: record.id,
    permitRequirementType: record.permitRequirementType,
    permitReference: record.permitReference,
    permitStatus: record.permitStatus,
    validFrom: record.validFrom ? record.validFrom.toISOString() : null,
    validUntil: record.validUntil ? record.validUntil.toISOString() : null,
    readinessStatus: deriveReadinessStatus({
      permitRequirementType: record.permitRequirementType,
      permitStatus: record.permitStatus,
      validFrom: record.validFrom,
      validUntil: record.validUntil,
      now,
    }),
    notes: record.notes,
  };
}

/**
 * Resolves the Vendor Work and its authoritative Building / Client context
 * from the Work Order (BE-08 is the authority for the Work Order's Building).
 */
async function resolveVendorWorkContext(vendorWorkId: string): Promise<{
  vendorWorkId: string;
  workOrderId: string;
  buildingId: string;
  clientId: string;
}> {
  const work = await vendorWorkRepository.findById(vendorWorkId);
  if (!work) {
    throw vendorWorkNotFoundError();
  }

  const workOrder = await workOrderRepository.findById(work.workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  if (workOrder.buildingId !== work.buildingId) {
    throw permitReadinessBuildingMismatchError();
  }

  return {
    vendorWorkId: work.id,
    workOrderId: workOrder.id,
    buildingId: workOrder.buildingId,
    clientId: workOrder.clientId,
  };
}

function assertValidValidity(validFrom: Date | null, validUntil: Date | null): void {
  if (validFrom && validUntil && validUntil.getTime() < validFrom.getTime()) {
    throw permitReadinessInvalidValidityError();
  }
}

function isDuplicateKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'work_permit_readiness_unique'
  );
}

export async function createWorkPermitReadiness(
  input: CreateWorkPermitReadinessInput,
  userId: string,
): Promise<PublicWorkPermitReadiness> {
  const context = await resolveVendorWorkContext(input.vendorWorkId);
  await contextAccessService.assertBuildingAccess(userId, context.buildingId);

  const permitStatus = input.permitStatus ?? 'PENDING';
  const validFrom = input.validFrom ?? null;
  const validUntil = input.validUntil ?? null;
  assertValidValidity(validFrom, validUntil);

  const existing =
    await workPermitReadinessRepository.findByVendorWorkAndType(
      context.vendorWorkId,
      input.permitRequirementType,
    );
  if (existing) {
    throw permitReadinessAlreadyExistsError();
  }

  const newReadiness: NewWorkPermitReadiness = {
    clientId: context.clientId,
    vendorWorkId: context.vendorWorkId,
    buildingId: context.buildingId,
    workOrderId: context.workOrderId,
    permitRequirementType: input.permitRequirementType,
    permitReference: input.permitReference ?? null,
    permitStatus,
    validFrom,
    validUntil,
    readinessStatus: deriveReadinessStatus({
      permitRequirementType: input.permitRequirementType,
      permitStatus,
      validFrom,
      validUntil,
    }),
    notes: input.notes ?? null,
    createdByUserId: userId,
  };

  try {
    const record = await workPermitReadinessRepository.create(newReadiness);
    await recordOperationalEvent({
      clientId: context.clientId,
      eventType: 'WORK_PERMIT_READINESS_CREATED',
      entityType: 'WORK_PERMIT_READINESS',
      entityId: record.id,
      actorUserId: userId,
      buildingId: context.buildingId,
      vendorWorkId: context.vendorWorkId,
      summary: `Work permit readiness created (${record.readinessStatus})`,
      metadata: {
        permitReadinessId: record.id,
        permitRequirementType: record.permitRequirementType,
        workOrderId: context.workOrderId,
      },
    });
    return toPublicWorkPermitReadiness(record);
  } catch (error) {
    if (isDuplicateKeyViolation(error)) {
      throw permitReadinessAlreadyExistsError();
    }
    throw error;
  }
}

export async function getWorkPermitReadiness(
  readinessId: string,
  userId: string,
): Promise<PublicWorkPermitReadiness> {
  const record = await workPermitReadinessRepository.findById(readinessId);
  if (!record) {
    throw permitReadinessNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicWorkPermitReadiness(record);
}

export async function listWorkPermitReadiness(
  filters: WorkPermitReadinessFilters,
  userId: string,
  accessibleBuildingIds: string[],
): Promise<PublicWorkPermitReadiness[]> {
  let effectiveFilters = filters;

  if (filters.vendorWorkId) {
    const work = await vendorWorkRepository.findById(filters.vendorWorkId);
    if (!work) {
      throw vendorWorkNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, work.buildingId);
    effectiveFilters = { ...filters, buildingId: work.buildingId };
  }

  if (effectiveFilters.vendorId && effectiveFilters.buildingId) {
    const relationship =
      await vendorBuildingRepository.findActiveByVendorAndBuilding(
        effectiveFilters.vendorId,
        effectiveFilters.buildingId,
      );
    if (!relationship) {
      throw permitReadinessBuildingMismatchError();
    }
  }

  const buildingIds =
    effectiveFilters.buildingId !== undefined
      ? [effectiveFilters.buildingId]
      : accessibleBuildingIds;

  if (buildingIds.length === 0) {
    return [];
  }

  const records = await workPermitReadinessRepository.list({
    vendorWorkId: effectiveFilters.vendorWorkId,
    vendorId: effectiveFilters.vendorId,
    buildingId: effectiveFilters.buildingId,
    buildingIds,
  });
  return records.map(toPublicWorkPermitReadiness);
}

/**
 * Resolves the current permit readiness of a Vendor Work, time-aware: each
 * permit's readiness is re-derived from its status and validity window at the
 * moment of resolution (so a permit that has since expired resolves EXPIRED),
 * and the work's overall readiness is aggregated. `ready` is the authoritative
 * gate — a work may only proceed when every required permit is READY (or no
 * permit is required).
 */
export async function resolveVendorWorkPermitReadiness(
  vendorWorkId: string,
  userId: string,
): Promise<VendorWorkPermitReadiness> {
  const work = await vendorWorkRepository.findById(vendorWorkId);
  if (!work) {
    throw vendorWorkNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, work.buildingId);
  return aggregateVendorWorkPermitReadiness(vendorWorkId);
}

/**
 * Access-neutral permit-readiness aggregation (CR-HM-BE-06 Run 2 §11): the
 * IDENTICAL rule authority as {@link resolveVendorWorkPermitReadiness} —
 * same zero-rows NOT_REQUIRED semantics, same per-permit status derivation,
 * same aggregation and `ready` fold — minus the BE-02G building-access
 * assertion, which stays in the gated public read above. Callers MUST be
 * independently preauthorized for the Vendor Work's Building (the governed
 * Handyman Work Session start command proves visit-scoped field authority
 * through the BE-06 lead chain).
 */
export async function aggregateVendorWorkPermitReadiness(
  vendorWorkId: string,
): Promise<VendorWorkPermitReadiness> {
  const work = await vendorWorkRepository.findById(vendorWorkId);
  if (!work) {
    throw vendorWorkNotFoundError();
  }

  const now = new Date();
  const records =
    await workPermitReadinessRepository.listByVendorWorkId(vendorWorkId);

  const permits = records.map((record) => toResolvedPermitReadiness(record, now));
  const readinessStatus = aggregateReadiness(
    permits.map((permit) => permit.readinessStatus),
  );

  return {
    vendorWorkId: work.id,
    buildingId: work.buildingId,
    ready: readinessStatus === 'READY' || readinessStatus === 'NOT_REQUIRED',
    readinessStatus,
    permits,
  };
}

export async function updateWorkPermitReadiness(
  readinessId: string,
  input: UpdateWorkPermitReadinessInput,
  userId: string,
): Promise<PublicWorkPermitReadiness> {
  const existing = await workPermitReadinessRepository.findById(readinessId);
  if (!existing) {
    throw permitReadinessNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  const permitStatus = input.permitStatus ?? existing.permitStatus;
  const permitReference =
    input.permitReference === undefined
      ? existing.permitReference
      : input.permitReference;
  const validFrom =
    input.validFrom === undefined ? existing.validFrom : input.validFrom;
  const validUntil =
    input.validUntil === undefined ? existing.validUntil : input.validUntil;
  const notes = input.notes === undefined ? existing.notes : input.notes;

  assertValidValidity(validFrom, validUntil);

  const readinessStatus = deriveReadinessStatus({
    permitRequirementType: existing.permitRequirementType,
    permitStatus,
    validFrom,
    validUntil,
  });

  const updated = await workPermitReadinessRepository.update(readinessId, {
    permitReference,
    permitStatus,
    validFrom,
    validUntil,
    readinessStatus,
    notes,
  });
  if (!updated) {
    throw permitReadinessNotFoundError();
  }

  await recordOperationalEvent({
    clientId: existing.clientId,
    eventType: 'WORK_PERMIT_READINESS_UPDATED',
    entityType: 'WORK_PERMIT_READINESS',
    entityId: existing.id,
    actorUserId: userId,
    buildingId: existing.buildingId,
    vendorWorkId: existing.vendorWorkId,
    summary: `Work permit readiness changed from ${existing.readinessStatus} to ${readinessStatus}`,
    metadata: {
      permitReadinessId: existing.id,
      permitRequirementType: existing.permitRequirementType,
      workOrderId: existing.workOrderId,
      from: existing.readinessStatus,
      to: readinessStatus,
    },
  });

  return toPublicWorkPermitReadiness(updated);
}

export const workPermitReadinessService = {
  createWorkPermitReadiness,
  deriveReadinessStatus,
  getWorkPermitReadiness,
  listWorkPermitReadiness,
  resolveVendorWorkPermitReadiness,
  toPublicWorkPermitReadiness,
  updateWorkPermitReadiness,
};
