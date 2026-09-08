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
  vendorWorkEvidenceBuildingMismatchError,
  vendorWorkEvidenceCountViolationError,
  vendorWorkEvidenceInvalidStateError,
  vendorWorkEvidenceNotFoundError,
  vendorWorkEvidenceRequirementMismatchError,
} from './vendor-work-evidence.errors';
import { vendorWorkEvidenceRepository } from './vendor-work-evidence.repository';
import type {
  PublicVendorWorkEvidence,
  PublicVendorWorkEvidenceRequirement,
  SubmitVendorWorkEvidenceInput,
  VendorWorkEvidenceFilters,
} from './vendor-work-evidence.types';
import { applyRetentionToEvidence } from '../evidence-retention-policies/evidence-retention-application.service';

/** The same MIME rules as BE-07 / BE-08G. */
const ALLOWED_MIME: Record<string, readonly string[]> = {
  PHOTO: ['image/jpeg', 'image/png', 'image/webp'],
  DOCUMENT: ['application/pdf', 'image/jpeg', 'image/png'],
  SIGNATURE: ['image/png', 'image/svg+xml'],
};

type ResolvedVendorWork = {
  id: string;
  clientId: string;
  buildingId: string;
  status: string;
};

/**
 * Loads a Vendor Work and resolves its authoritative Building / Client context
 * from the BE-08 Work Order (the authority for the Work Order's Building).
 */
async function resolveVendorWork(vendorWorkId: string): Promise<ResolvedVendorWork> {
  const work = await vendorWorkRepository.findById(vendorWorkId);
  if (!work) {
    throw vendorWorkNotFoundError();
  }
  const workOrder = await workOrderRepository.findById(work.workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  if (workOrder.buildingId !== work.buildingId) {
    throw vendorWorkEvidenceBuildingMismatchError();
  }
  return {
    id: work.id,
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
    status: work.status,
  };
}

/**
 * Resolves the ACTIVE BE-07 evidence requirements bound to a Vendor Work
 * (`target_type = 'VENDOR_WORK'`).
 */
export async function resolveVendorWorkEvidenceRequirements(
  vendorWorkId: string,
  userId: string,
): Promise<PublicVendorWorkEvidenceRequirement[]> {
  const work = await resolveVendorWork(vendorWorkId);
  await contextAccessService.assertBuildingAccess(userId, work.buildingId);
  return vendorWorkEvidenceRepository.listRequirementsForVendorWork(work.id);
}

/**
 * Binds a PHOTO / DOCUMENT / SIGNATURE submission to a Vendor Work through the
 * BE-07 evidence engine.
 *
 * Validation order (pinned by tests):
 *   1. unknown Vendor Work           → 404 VENDOR_WORK_NOT_FOUND
 *   2. unknown Work Order            → 404 WORK_ORDER_NOT_FOUND
 *   3. completed Vendor Work         → 400 VENDOR_WORK_EVIDENCE_INVALID_STATE
 *   4. unknown / mismatched requirement → 400 VENDOR_WORK_EVIDENCE_REQUIREMENT_MISMATCH
 *   5. evidence type mismatch        → 400 VENDOR_WORK_EVIDENCE_REQUIREMENT_MISMATCH
 *   6. MIME mismatch                 → 400 VENDOR_WORK_EVIDENCE_REQUIREMENT_MISMATCH
 *   7. max-count exceeded            → 400 VENDOR_WORK_EVIDENCE_COUNT_VIOLATION
 */
export async function submitVendorWorkEvidence(
  input: SubmitVendorWorkEvidenceInput,
): Promise<PublicVendorWorkEvidence> {
  const work = await resolveVendorWork(input.vendorWorkId);
  await contextAccessService.assertBuildingAccess(input.submittedByUserId, work.buildingId);

  if (work.status === 'COMPLETED') {
    throw vendorWorkEvidenceInvalidStateError();
  }

  let requirement: PublicVendorWorkEvidenceRequirement | null = null;
  if (input.evidenceRequirementId !== undefined) {
    requirement =
      await vendorWorkEvidenceRepository.findRequirementByIdForVendorWork(
        work.id,
        input.evidenceRequirementId,
      );
    if (!requirement) {
      throw vendorWorkEvidenceRequirementMismatchError();
    }
    if (requirement.evidenceType !== input.evidenceType) {
      throw vendorWorkEvidenceRequirementMismatchError();
    }
  }

  const allowed = ALLOWED_MIME[input.evidenceType];
  if (!allowed || !allowed.includes(input.mimeType)) {
    throw vendorWorkEvidenceRequirementMismatchError();
  }

  if (requirement && requirement.maximumCount !== null) {
    const count =
      await vendorWorkEvidenceRepository.countActiveSubmissionsForRequirement(
        requirement.id,
      );
    if (count >= requirement.maximumCount) {
      throw vendorWorkEvidenceCountViolationError();
    }
  }

  const evidence = await vendorWorkEvidenceRepository.createSubmission({
    ...input,
    clientId: work.clientId,
  });
  // CR-BE-DOC-CONTROL-01 PART 03 — attach retention governance at creation.
  await applyRetentionToEvidence(String(evidence.id), input.submittedByUserId);
  await recordOperationalEvent({
    clientId: work.clientId,
    eventType: 'VENDOR_WORK_EVIDENCE_ADDED',
    entityType: 'VENDOR_WORK',
    entityId: work.id,
    actorUserId: input.submittedByUserId,
    buildingId: work.buildingId,
    vendorWorkId: work.id,
    summary: `Vendor work evidence added (${input.evidenceType})`,
    metadata: { evidenceType: input.evidenceType, evidenceId: evidence.id },
  });
  return evidence;
}

/** Lists the ACTIVE evidence submissions bound to a Vendor Work. */
export async function listVendorWorkEvidence(
  vendorWorkId: string,
  userId: string,
): Promise<PublicVendorWorkEvidence[]> {
  const work = await resolveVendorWork(vendorWorkId);
  await contextAccessService.assertBuildingAccess(userId, work.buildingId);
  return vendorWorkEvidenceRepository.listSubmissionsForVendorWork(work.id);
}

/**
 * Lists evidence across the caller's accessible Buildings, narrowed by Vendor
 * Work / Vendor / Building. When both a Vendor and a Building filter are
 * supplied, the Vendor must hold an ACTIVE relationship to that Building.
 */
export async function listVendorWorkEvidenceByFilters(
  filters: VendorWorkEvidenceFilters,
  userId: string,
  accessibleBuildingIds: string[],
): Promise<PublicVendorWorkEvidence[]> {
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
      throw vendorWorkEvidenceBuildingMismatchError();
    }
  }

  const buildingIds =
    effectiveFilters.buildingId !== undefined
      ? [effectiveFilters.buildingId]
      : accessibleBuildingIds;

  if (buildingIds.length === 0) {
    return [];
  }

  return vendorWorkEvidenceRepository.listSubmissions({
    vendorWorkId: effectiveFilters.vendorWorkId,
    vendorId: effectiveFilters.vendorId,
    buildingId: effectiveFilters.buildingId,
    buildingIds,
  });
}

/**
 * Removes (soft-deactivates) a Vendor Work evidence submission, following the
 * BE-07 remove rule (`status → 'REMOVED'`). The submission must belong to a
 * Vendor Work whose Building the caller can access.
 */
export async function removeVendorWorkEvidence(
  evidenceId: string,
  userId: string,
): Promise<PublicVendorWorkEvidence> {
  const existing = await vendorWorkEvidenceRepository.findSubmissionById(
    evidenceId,
  );
  if (!existing) {
    throw vendorWorkEvidenceNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(
    userId,
    (await resolveVendorWork(existing.vendorWorkId)).buildingId,
  );

  const removed = await vendorWorkEvidenceRepository.removeSubmission(evidenceId);
  if (!removed) {
    throw vendorWorkEvidenceNotFoundError();
  }

  await recordOperationalEvent({
    clientId: removed.clientId,
    eventType: 'VENDOR_WORK_EVIDENCE_REMOVED',
    entityType: 'VENDOR_WORK',
    entityId: removed.vendorWorkId,
    actorUserId: userId,
    buildingId: (await resolveVendorWork(removed.vendorWorkId)).buildingId,
    vendorWorkId: removed.vendorWorkId,
    summary: 'Vendor work evidence removed',
    metadata: { evidenceType: removed.evidenceType, evidenceId: removed.id },
  });
  return removed;
}

export const vendorWorkEvidenceService = {
  listVendorWorkEvidence,
  listVendorWorkEvidenceByFilters,
  removeVendorWorkEvidence,
  resolveVendorWorkEvidenceRequirements,
  submitVendorWorkEvidence,
};
