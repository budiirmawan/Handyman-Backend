import { resolveAssetBuildingContext } from '../assets';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import { organizationRepository } from '../organizations';
import { securityPostNotFoundError, securityPostRepository } from '../security-posts';
import { workforceBuildingAssignmentRepository } from '../workforce-building-assignments';
import {
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import {
  securityVisitorBindingAlreadyExistsError,
  securityVisitorBindingNotFoundError,
  securityVisitorBindingSecurityPostBuildingMismatchError,
  securityVisitorBindingSecurityPostInactiveError,
  securityVisitorBindingWorkforceBuildingMismatchError,
  securityVisitorBindingWorkforceInactiveError,
} from './security-visitor-binding.errors';
import { securityVisitorBindingRepository } from './security-visitor-binding.repository';
import type {
  CreateSecurityVisitorBindingInput,
  PublicSecurityVisitorBinding,
  SecurityVisitorBindingListFilters,
  SecurityVisitorBindingRecord,
  UpdateSecurityVisitorBindingInput,
} from './security-visitor-binding.types';

/**
 * BE-12J — Visitor / Security Binding service.
 *
 * Configuration-only layer that records the Security operational
 * context (Building × optional Security Post × optional Security
 * Workforce) for an (opaque, future-authoritative) Visit reference.
 *
 * The repository has no authoritative Visitor / Visit domain today,
 * so this PART carries the visit reference as a free-form
 * `external_visit_reference` string. When a Visitor module is added
 * in a later BE-12 PART, the binding can be extended to resolve the
 * reference to the authoritative Visitor / Visit id; until then the
 * binding is purely Security-side configuration. No visitor personal
 * data is stored.
 *
 * Validation order (pinned by tests):
 *   1. unknown Building                      → 404 BUILDING_NOT_FOUND
 *   2. inaccessible Building                 → 403 BUILDING_ACCESS_DENIED
 *   3. unknown / cross-Building / INACTIVE
 *      Security Post                         → 404 / 400 / 400
 *   4. unknown / INACTIVE / cross-Client
 *      Workforce                             → 404 / 400 / 400
 *   5. Workforce with no active Building
 *      assignment for this Building          → 400
 *   6. duplicate ACTIVE (building, ref)      → 409 ALREADY_EXISTS
 */
export async function createSecurityVisitorBinding(
  input: CreateSecurityVisitorBindingInput,
  userId: string,
): Promise<PublicSecurityVisitorBinding> {
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, input.buildingId);

  const { clientId } = await resolveAssetBuildingContext(input.buildingId);

  if (input.securityPostId) {
    await assertSecurityPost(
      input.securityPostId,
      input.buildingId,
      clientId,
    );
  }
  if (input.securityWorkforceId) {
    await assertWorkforce(
      input.securityWorkforceId,
      input.buildingId,
      clientId,
    );
  }

  const activeForRef =
    await securityVisitorBindingRepository.findActiveByBuildingAndReference(
      input.buildingId,
      input.externalVisitReference,
    );
  if (activeForRef) {
    throw securityVisitorBindingAlreadyExistsError();
  }

  let record: SecurityVisitorBindingRecord;
  try {
    record = await securityVisitorBindingRepository.create({
      ...input,
      clientId,
    });
  } catch (error) {
    if (
      isUniqueViolation(
        error,
        'security_visitor_binding_active_building_ref',
      )
    ) {
      throw securityVisitorBindingAlreadyExistsError();
    }
    throw error;
  }
  return toPublicSecurityVisitorBinding(record);
}

export async function getSecurityVisitorBinding(
  id: string,
  userId: string,
): Promise<PublicSecurityVisitorBinding> {
  const record = await securityVisitorBindingRepository.findById(id);
  if (!record) {
    throw securityVisitorBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicSecurityVisitorBinding(record);
}

export async function listSecurityVisitorBindings(
  filters: SecurityVisitorBindingListFilters,
  userId: string,
): Promise<PublicSecurityVisitorBinding[]> {
  let buildingIds: string[];

  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    buildingIds = [filters.buildingId];
  } else if (filters.securityPostId) {
    const post = await securityPostRepository.findById(filters.securityPostId);
    if (!post) {
      throw securityPostNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, post.buildingId);
    buildingIds = [post.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const records = await securityVisitorBindingRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return records.map(toPublicSecurityVisitorBinding);
}

export async function updateSecurityVisitorBinding(
  id: string,
  input: UpdateSecurityVisitorBindingInput,
  userId: string,
): Promise<PublicSecurityVisitorBinding> {
  const existing = await securityVisitorBindingRepository.findById(id);
  if (!existing) {
    throw securityVisitorBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  const { clientId } = await resolveAssetBuildingContext(existing.buildingId);

  if (input.securityPostId !== undefined && input.securityPostId) {
    await assertSecurityPost(
      input.securityPostId,
      existing.buildingId,
      clientId,
    );
  }
  if (
    input.securityWorkforceId !== undefined &&
    input.securityWorkforceId
  ) {
    await assertWorkforce(
      input.securityWorkforceId,
      existing.buildingId,
      clientId,
    );
  }

  if (
    input.status === 'ACTIVE' &&
    existing.status !== 'ACTIVE'
  ) {
    const targetRef =
      input.externalVisitReference ?? existing.externalVisitReference;
    const stillActive =
      await securityVisitorBindingRepository.findActiveByBuildingAndReference(
        existing.buildingId,
        targetRef,
      );
    if (stillActive && stillActive.id !== id) {
      throw securityVisitorBindingAlreadyExistsError();
    }
  }

  const updated = await securityVisitorBindingRepository.update(id, input);
  if (!updated) {
    throw securityVisitorBindingNotFoundError();
  }
  return toPublicSecurityVisitorBinding(updated);
}

/**
 * Resolves a free-form `external_visit_reference` against the Security
 * bindings for the caller's accessible Buildings. Returns the ACTIVE
 * binding that matches the reference (or null). This is the
 * future-link hook: once a Visitor / Visit domain exists, the
 * reference value is the join key.
 */
export async function resolveSecurityVisitorBindingByReference(
  buildingId: string,
  externalVisitReference: string,
  userId: string,
): Promise<PublicSecurityVisitorBinding | null> {
  await contextAccessService.assertBuildingAccess(userId, buildingId);
  const record =
    await securityVisitorBindingRepository.findActiveByBuildingAndReference(
      buildingId,
      externalVisitReference,
    );
  return record ? toPublicSecurityVisitorBinding(record) : null;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function assertSecurityPost(
  securityPostId: string,
  buildingId: string,
  clientId: string,
): Promise<void> {
  const post = await securityPostRepository.findById(securityPostId);
  if (!post) {
    throw securityPostNotFoundError();
  }
  if (post.buildingId !== buildingId || post.clientId !== clientId) {
    throw securityVisitorBindingSecurityPostBuildingMismatchError();
  }
  if (post.status !== 'ACTIVE') {
    throw securityVisitorBindingSecurityPostInactiveError();
  }
}

async function assertWorkforce(
  workforceProfileId: string,
  buildingId: string,
  clientId: string,
): Promise<void> {
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile) {
    throw workforceProfileNotFoundError();
  }
  if (profile.status !== 'ACTIVE') {
    throw securityVisitorBindingWorkforceInactiveError();
  }
  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    throw workforceProfileNotFoundError();
  }
  if (organization.clientId !== clientId) {
    throw securityVisitorBindingWorkforceBuildingMismatchError();
  }
  const assignment =
    await workforceBuildingAssignmentRepository.findActiveByProfileAndBuilding(
      workforceProfileId,
      buildingId,
    );
  if (!assignment) {
    throw securityVisitorBindingWorkforceBuildingMismatchError();
  }
}

function isUniqueViolation(
  error: unknown,
  constraint: string,
): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function toPublicSecurityVisitorBinding(
  record: SecurityVisitorBindingRecord,
): PublicSecurityVisitorBinding {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    securityPostId: record.securityPostId,
    securityWorkforceId: record.securityWorkforceId,
    externalVisitReference: record.externalVisitReference,
    securityContext: record.securityContext,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export const securityVisitorBindingService = {
  createSecurityVisitorBinding,
  getSecurityVisitorBinding,
  listSecurityVisitorBindings,
  resolveSecurityVisitorBindingByReference,
  updateSecurityVisitorBinding,
};
