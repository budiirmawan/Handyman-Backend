import { ERROR_CODES } from '../../shared/errors';
import { contractorContextService } from '../contractor-contexts/contractor-context.service';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { permitRepository } from '../permits/permit.repository';
import {
  permitEvidenceAlreadyRemovedError,
  permitEvidenceContextMismatchError,
  permitEvidenceCountViolationError,
  permitEvidenceNotFoundError,
  permitEvidencePermitInvalidError,
  permitEvidenceRequirementAlreadyExistsError,
  permitEvidenceRequirementInvalidError,
  permitEvidenceTypeMismatchError,
} from './permit-evidence.errors';
import { permitEvidenceRepository } from './permit-evidence.repository';
import type {
  CreatePermitEvidenceRequirementInput,
  PermitEvidenceContextAssertion,
  PermitEvidenceFilters,
  PermitEvidenceReadiness,
  PermitEvidenceType,
  PublicPermitEvidence,
  PublicPermitEvidenceRequirement,
  SubmitPermitEvidenceInput,
} from './permit-evidence.types';
import { applyRetentionToEvidence } from '../evidence-retention-policies/evidence-retention-application.service';

const ALLOWED_MIME: Record<PermitEvidenceType, readonly string[]> = {
  PHOTO: ['image/jpeg', 'image/png', 'image/webp'],
  DOCUMENT: ['application/pdf', 'image/jpeg', 'image/png'],
  SIGNATURE: ['image/png', 'image/svg+xml'],
};

function permitContextId(permit: { contractorVendorId: string; tenantContractorRelationshipId: string | null }): string {
  return permit.tenantContractorRelationshipId ?? permit.contractorVendorId;
}

async function resolvePermitContext(
  permitId: string,
  actorUserId: string,
  assertion?: PermitEvidenceContextAssertion,
) {
  const permit = await permitRepository.findById(permitId);
  if (!permit || permit.status === 'CANCELLED') throw permitEvidencePermitInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  const contextId = permitContextId(permit);
  if (assertion && (
    assertion.buildingId !== permit.buildingId ||
    assertion.contractorContextType !== permit.contractorContextType ||
    assertion.contractorContextId !== contextId
  )) throw permitEvidenceContextMismatchError();
  try {
    await contractorContextService.resolveContractorContext({
      contractorContextType: permit.contractorContextType,
      contractorContextId: contextId,
      buildingId: permit.buildingId,
    }, actorUserId);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? error.code : undefined;
    if (code === ERROR_CODES.CONTRACTOR_CONTEXT_INVALID ||
        code === ERROR_CODES.CONTRACTOR_CONTEXT_INACTIVE ||
        code === ERROR_CODES.CONTRACTOR_CONTEXT_BUILDING_MISMATCH ||
        code === ERROR_CODES.CONTRACTOR_CONTEXT_BUILDING_REQUIRED) {
      throw permitEvidenceContextMismatchError();
    }
    throw error;
  }
  return permit;
}

function isRequirementUnique(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const item = error as { code?: string; constraint?: string };
  return item.code === '23505' && item.constraint === 'evidence_active_unique';
}

export async function createPermitEvidenceRequirement(
  permitId: string,
  input: CreatePermitEvidenceRequirementInput,
  actorUserId: string,
): Promise<PublicPermitEvidenceRequirement> {
  const permit = await resolvePermitContext(permitId, actorUserId, input);
  try {
    const requirement = await permitEvidenceRepository.createRequirement(
      permit.id, permit.clientId, input,
    );
    await recordEvidenceEvent(permit, actorUserId, 'PERMIT_EVIDENCE_REQUIREMENT_CREATED', {
      evidenceRequirementId: requirement.id,
      evidenceType: requirement.evidenceType,
      required: requirement.required,
      minimumCount: requirement.minimumCount,
    });
    return requirement;
  } catch (error) {
    if (isRequirementUnique(error)) throw permitEvidenceRequirementAlreadyExistsError();
    throw error;
  }
}

export async function resolvePermitEvidenceRequirements(
  permitId: string,
  actorUserId: string,
): Promise<PublicPermitEvidenceRequirement[]> {
  const permit = await resolvePermitContext(permitId, actorUserId);
  const requirements = await permitEvidenceRepository.listRequirements(permit.id);
  if (requirements.some((item) => item.clientId !== permit.clientId)) {
    throw permitEvidenceRequirementInvalidError();
  }
  return requirements;
}

export async function submitPermitEvidence(
  permitId: string,
  input: SubmitPermitEvidenceInput,
  actorUserId: string,
): Promise<PublicPermitEvidence> {
  const permit = await resolvePermitContext(permitId, actorUserId, input);
  const requirement = await permitEvidenceRepository.findRequirementForPermit(
    permit.id, input.evidenceRequirementId,
  );
  if (!requirement || requirement.clientId !== permit.clientId) {
    throw permitEvidenceRequirementInvalidError();
  }
  if (requirement.evidenceType !== input.evidenceType) {
    throw permitEvidenceTypeMismatchError();
  }
  if (!ALLOWED_MIME[input.evidenceType].includes(input.mimeType)) {
    throw permitEvidenceTypeMismatchError();
  }
  if (requirement.maximumCount !== null) {
    const count = await permitEvidenceRepository.countActive(requirement.id);
    if (count >= requirement.maximumCount) throw permitEvidenceCountViolationError();
  }
  const evidence = await permitEvidenceRepository.createSubmission(
    permit.id, permit.clientId, input, actorUserId,
  );
  // CR-BE-DOC-CONTROL-01 PART 03 — attach retention governance at creation.
  await applyRetentionToEvidence(String(evidence.id), actorUserId);
  await recordEvidenceEvent(permit, actorUserId, 'PERMIT_EVIDENCE_SUBMITTED', {
    evidenceId: evidence.id,
    evidenceRequirementId: evidence.evidenceRequirementId,
    evidenceType: evidence.evidenceType,
    fileReference: evidence.fileReference,
  });
  return evidence;
}

export async function getPermitEvidence(
  evidenceId: string,
  actorUserId: string,
): Promise<PublicPermitEvidence> {
  const evidence = await permitEvidenceRepository.findSubmissionById(evidenceId);
  if (!evidence) throw permitEvidenceNotFoundError();
  await resolvePermitContext(evidence.permitId, actorUserId);
  return evidence;
}

export async function listPermitEvidence(
  permitId: string,
  actorUserId: string,
): Promise<PublicPermitEvidence[]> {
  await resolvePermitContext(permitId, actorUserId);
  return permitEvidenceRepository.listSubmissions(permitId);
}

export async function listPermitEvidenceByFilters(
  filters: PermitEvidenceFilters,
  actorUserId: string,
): Promise<PublicPermitEvidence[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return permitEvidenceRepository.listByFilters(filters, buildingIds);
}

export async function validatePermitEvidenceReadiness(
  permitId: string,
  actorUserId: string,
): Promise<PermitEvidenceReadiness> {
  const permit = await resolvePermitContext(permitId, actorUserId);
  const [requirements, submissions] = await Promise.all([
    permitEvidenceRepository.listRequirements(permit.id),
    permitEvidenceRepository.listSubmissions(permit.id),
  ]);
  const missingEvidenceTypes: PermitEvidenceType[] = [];
  const detail = requirements.map((requirement) => {
    const activeCount = submissions.filter(
      (item) => item.evidenceRequirementId === requirement.id && item.status === 'ACTIVE',
    ).length;
    const satisfied = !requirement.required || activeCount >= requirement.minimumCount;
    if (!satisfied) missingEvidenceTypes.push(requirement.evidenceType);
    return {
      evidenceRequirementId: requirement.id,
      evidenceType: requirement.evidenceType,
      required: requirement.required,
      minimumCount: requirement.minimumCount,
      maximumCount: requirement.maximumCount,
      activeCount,
      satisfied,
    };
  });
  return {
    permitId: permit.id,
    permitReference: permit.permitNumber,
    buildingId: permit.buildingId,
    contractorContextType: permit.contractorContextType,
    contractorVendorId: permit.contractorVendorId,
    configured: requirements.length > 0,
    ready: missingEvidenceTypes.length === 0,
    missingEvidenceTypes,
    requirements: detail,
  };
}

export async function removePermitEvidence(
  evidenceId: string,
  actorUserId: string,
): Promise<PublicPermitEvidence> {
  const existing = await permitEvidenceRepository.findSubmissionById(evidenceId);
  if (!existing) throw permitEvidenceNotFoundError();
  const permit = await resolvePermitContext(existing.permitId, actorUserId);
  if (existing.status !== 'ACTIVE') throw permitEvidenceAlreadyRemovedError();
  const removed = await permitEvidenceRepository.removeSubmission(evidenceId);
  if (!removed) throw permitEvidenceAlreadyRemovedError();
  await recordEvidenceEvent(permit, actorUserId, 'PERMIT_EVIDENCE_REMOVED', {
    evidenceId: removed.id,
    evidenceType: removed.evidenceType,
  });
  return removed;
}

async function recordEvidenceEvent(
  permit: { id: string; clientId: string; buildingId: string },
  actorUserId: string,
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordOperationalEvent({
    clientId: permit.clientId,
    buildingId: permit.buildingId,
    entityType: 'PERMIT',
    entityId: permit.id,
    eventType,
    actorUserId,
    summary: eventType.replaceAll('_', ' ').toLowerCase(),
    metadata,
  });
}

export const permitEvidenceService = {
  createPermitEvidenceRequirement,
  getPermitEvidence,
  listPermitEvidence,
  listPermitEvidenceByFilters,
  removePermitEvidence,
  resolvePermitEvidenceRequirements,
  submitPermitEvidence,
  validatePermitEvidenceReadiness,
};
