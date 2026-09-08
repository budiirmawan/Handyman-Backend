import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import { resolveAssetBuildingContext } from '../assets';
import {
  securityShiftHandoverBindingAlreadyExistsError,
  securityShiftHandoverBindingNotFoundError,
  securityShiftHandoverBuildingMismatchError,
  securityShiftHandoverPatrolRouteBuildingMismatchError,
  securityShiftHandoverPatrolRouteInactiveError,
  securityShiftHandoverStartPostBuildingMismatchError,
  securityShiftHandoverStartPostInactiveError,
} from './security-shift-handover.errors';
import { securityShiftHandoverBindingRepository } from './security-shift-handover.repository';
import type {
  CreateSecurityShiftHandoverBindingInput,
  PublicSecurityShiftHandoverBinding,
  SecurityShiftHandoverBindingFilter,
  SecurityShiftHandoverBindingRecord,
  UpdateSecurityShiftHandoverBindingInput,
} from './security-shift-handover.types';

/**
 * BE-12G — Security Shift Handover binding service.
 *
 * The binding row is a Security-side join between an existing BE-10J
 * `shift_handovers` row and a BE-12A start Security Post (+ optional
 * BE-12B Patrol Route) under the same Building. The BE-10J handover
 * lifecycle (DRAFT → READY → ACKNOWLEDGED) is the only authority on the
 * handover status; this binding layer only attaches the Security
 * context. Its own ACTIVE/INACTIVE status is independent of the
 * handover lifecycle.
 *
 * Validation order (pinned by tests):
 *   1. unknown Building                       → 404 BUILDING_NOT_FOUND
 *   2. inaccessible Building                  → 403 BUILDING_ACCESS_DENIED
 *   3. unknown handover                       → 404 NOT_FOUND
 *   4. cross-Building handover                → 400 SECURITY_SHIFT_HANDOVER_BUILDING_MISMATCH
 *   5. cross-Client handover                  → 400 SECURITY_SHIFT_HANDOVER_BUILDING_MISMATCH
 *   6. unknown / cross-Building / INACTIVE
 *      start Security Post                    → 404 / 400 / 400
 *   7. unknown / cross-Building / INACTIVE
 *      Patrol Route                           → 404 / 400 / 400
 *   8. duplicate ACTIVE binding              → 409 SECURITY_SHIFT_HANDOVER_BINDING_ALREADY_EXISTS
 */
export async function createSecurityShiftHandoverBinding(
  input: CreateSecurityShiftHandoverBindingInput,
  userId: string,
): Promise<PublicSecurityShiftHandoverBinding> {
  const { clientId } = await assertBuilding(input.buildingId, userId);

  const handover =
    await securityShiftHandoverBindingRepository.findShiftHandover(
      input.shiftHandoverId,
    );
  if (!handover) {
    throw AppError.notFound('Shift handover not found.');
  }
  if (handover.building_id !== input.buildingId) {
    throw securityShiftHandoverBuildingMismatchError();
  }
  if (handover.client_id !== clientId) {
    throw securityShiftHandoverBuildingMismatchError();
  }

  if (input.startSecurityPostId) {
    await assertStartSecurityPost(
      input.startSecurityPostId,
      input.buildingId,
      clientId,
    );
  }

  if (input.patrolRouteId) {
    await assertPatrolRoute(
      input.patrolRouteId,
      input.buildingId,
      clientId,
    );
  }

  const activeExisting =
    await securityShiftHandoverBindingRepository.findActiveByHandoverId(
      input.shiftHandoverId,
    );
  if (activeExisting) {
    throw securityShiftHandoverBindingAlreadyExistsError();
  }

  try {
    const record = await securityShiftHandoverBindingRepository.create({
      clientId,
      buildingId: input.buildingId,
      shiftHandoverId: input.shiftHandoverId,
      startSecurityPostId: input.startSecurityPostId ?? null,
      patrolRouteId: input.patrolRouteId ?? null,
      status: input.status ?? 'ACTIVE',
      createdByUserId: userId,
    });
    return toPublicSecurityShiftHandoverBinding(record);
  } catch (error) {
    if (isActiveBindingUniqueViolation(error)) {
      throw securityShiftHandoverBindingAlreadyExistsError();
    }
    throw error;
  }
}

export async function getSecurityShiftHandoverBinding(
  id: string,
  userId: string,
): Promise<PublicSecurityShiftHandoverBinding> {
  const record =
    await securityShiftHandoverBindingRepository.findById(id);
  if (!record) {
    throw securityShiftHandoverBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicSecurityShiftHandoverBinding(record);
}

export async function listSecurityShiftHandoverBindings(
  filters: SecurityShiftHandoverBindingFilter,
  userId: string,
): Promise<PublicSecurityShiftHandoverBinding[]> {
  let records: SecurityShiftHandoverBindingRecord[];

  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      userId,
      filters.buildingId,
    );
    records = await securityShiftHandoverBindingRepository.list(filters);
  } else if (filters.shiftHandoverId) {
    const handover =
      await securityShiftHandoverBindingRepository.findShiftHandover(
        filters.shiftHandoverId,
      );
    if (!handover) {
      throw AppError.notFound('Shift handover not found.');
    }
    await contextAccessService.assertBuildingAccess(
      userId,
      handover.building_id,
    );
    records = await securityShiftHandoverBindingRepository.list(filters);
  } else {
    const buildingIds =
      await contextAccessService.getAccessibleBuildingIds(userId);
    records = await securityShiftHandoverBindingRepository.listByBuildingIds(
      buildingIds,
      filters,
    );
  }

  return records.map(toPublicSecurityShiftHandoverBinding);
}

export async function updateSecurityShiftHandoverBinding(
  id: string,
  input: UpdateSecurityShiftHandoverBindingInput,
  userId: string,
): Promise<PublicSecurityShiftHandoverBinding> {
  const existing =
    await securityShiftHandoverBindingRepository.findById(id);
  if (!existing) {
    throw securityShiftHandoverBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  // Re-derive the authoritative clientId for this binding's building.
  const { clientId } = await resolveAssetBuildingContext(existing.buildingId);

  if (input.startSecurityPostId !== undefined && input.startSecurityPostId) {
    await assertStartSecurityPost(
      input.startSecurityPostId,
      existing.buildingId,
      clientId,
    );
  }
  if (input.patrolRouteId !== undefined && input.patrolRouteId) {
    await assertPatrolRoute(
      input.patrolRouteId,
      existing.buildingId,
      clientId,
    );
  }

  if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
    const stillActive =
      await securityShiftHandoverBindingRepository.findActiveByHandoverId(
        existing.shiftHandoverId,
      );
    if (stillActive && stillActive.id !== id) {
      throw securityShiftHandoverBindingAlreadyExistsError();
    }
  }

  try {
    const updated = await securityShiftHandoverBindingRepository.update(
      id,
      input,
    );
    if (!updated) {
      throw securityShiftHandoverBindingNotFoundError();
    }
    return toPublicSecurityShiftHandoverBinding(updated);
  } catch (error) {
    if (isActiveBindingUniqueViolation(error)) {
      throw securityShiftHandoverBindingAlreadyExistsError();
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function toPublicSecurityShiftHandoverBinding(
  record: SecurityShiftHandoverBindingRecord,
): PublicSecurityShiftHandoverBinding {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    shiftHandoverId: record.shiftHandoverId,
    startSecurityPostId: record.startSecurityPostId,
    patrolRouteId: record.patrolRouteId,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function assertBuilding(
  buildingId: string,
  userId: string,
): Promise<{ clientId: string }> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, buildingId);
  if (building.status !== 'ACTIVE') {
    throw AppError.badRequest('Building is not active.');
  }
  const { clientId } = await resolveAssetBuildingContext(buildingId);
  return { clientId };
}

async function assertStartSecurityPost(
  securityPostId: string,
  buildingId: string,
  clientId: string,
): Promise<void> {
  const post =
    await securityShiftHandoverBindingRepository.findSecurityPost(
      securityPostId,
    );
  if (!post) {
    throw AppError.notFound('Security post not found.');
  }
  if (post.building_id !== buildingId) {
    throw securityShiftHandoverStartPostBuildingMismatchError();
  }
  if (post.client_id !== clientId) {
    throw securityShiftHandoverStartPostBuildingMismatchError();
  }
  if (post.status !== 'ACTIVE') {
    throw securityShiftHandoverStartPostInactiveError();
  }
}

async function assertPatrolRoute(
  patrolRouteId: string,
  buildingId: string,
  clientId: string,
): Promise<void> {
  const route =
    await securityShiftHandoverBindingRepository.findPatrolRoute(
      patrolRouteId,
    );
  if (!route) {
    throw AppError.notFound('Patrol route not found.');
  }
  if (route.building_id !== buildingId) {
    throw securityShiftHandoverPatrolRouteBuildingMismatchError();
  }
  if (route.client_id !== clientId) {
    throw securityShiftHandoverPatrolRouteBuildingMismatchError();
  }
  if (route.status !== 'ACTIVE') {
    throw securityShiftHandoverPatrolRouteInactiveError();
  }
}

function isActiveBindingUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'security_shift_handover_binding_active_unique'
  );
}

export const securityShiftHandoverBindingService = {
  createSecurityShiftHandoverBinding,
  getSecurityShiftHandoverBinding,
  listSecurityShiftHandoverBindings,
  toPublicSecurityShiftHandoverBinding,
  updateSecurityShiftHandoverBinding,
};
