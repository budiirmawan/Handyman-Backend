import { contextAccessService } from '../context-access';
import { visitCheckInRepository } from '../visit-check-ins/visit-check-in.repository';
import {
  visitorPassActiveAlreadyExistsError,
  visitorPassBuildingMismatchError,
  visitorPassCodeAlreadyExistsError,
  visitorPassIssueTimeInvalidError,
  visitorPassNotActiveError,
  visitorPassNotFoundError,
  visitorPassReturnTimeInvalidError,
  visitorPassVisitNotActiveError,
  visitorPassVisitNotFoundError,
} from './visitor-pass.errors';
import { visitorPassRepository } from './visitor-pass.repository';
import type {
  IssueVisitorPassInput,
  PublicVisitorPass,
  ReturnVisitorPassInput,
  VisitorPassListFilters,
  VisitorPassRecord,
} from './visitor-pass.types';

/**
 * BE-13I — Visitor Pass service.
 *
 * The referenced visit check-in is authoritative for Client, Building
 * and active-visit state. A caller cannot place a pass in a different
 * context. One ACTIVE pass per visit and globally unique pass codes are
 * enforced both here and by database constraints.
 */

export async function issueVisitorPass(
  input: IssueVisitorPassInput,
  userId: string,
): Promise<PublicVisitorPass> {
  const visit = await visitCheckInRepository.findById(input.visitCheckInId);
  if (!visit) {
    throw visitorPassVisitNotFoundError();
  }

  // Authorize against authoritative visit context before reporting a
  // caller-supplied Building mismatch.
  await contextAccessService.assertBuildingAccess(userId, visit.buildingId);

  if (input.buildingId !== visit.buildingId) {
    throw visitorPassBuildingMismatchError();
  }
  if (visit.status !== 'CHECKED_IN') {
    throw visitorPassVisitNotActiveError();
  }

  if (input.issuedAt) {
    const issuedAt = new Date(input.issuedAt).getTime();
    if (
      issuedAt > Date.now() ||
      issuedAt < visit.checkedInAt.getTime()
    ) {
      throw visitorPassIssueTimeInvalidError();
    }
  }

  // Preserve deterministic validation: reused codes are reported before
  // the one-active-pass conflict when both inputs conflict.
  if (await visitorPassRepository.findByCode(input.passCode)) {
    throw visitorPassCodeAlreadyExistsError();
  }
  if (
    await visitorPassRepository.findActiveByVisitCheckInId(
      input.visitCheckInId,
    )
  ) {
    throw visitorPassActiveAlreadyExistsError();
  }

  let record: VisitorPassRecord;
  try {
    record = await visitorPassRepository.create({
      clientId: visit.clientId,
      buildingId: visit.buildingId,
      visitCheckInId: visit.id,
      passCode: input.passCode,
      issuedAt: input.issuedAt ?? null,
      issuedByUserId: input.issuedByUserId,
    });
  } catch (error) {
    if (isConstraintViolation(error, 'visitor_passes_code_unique')) {
      throw visitorPassCodeAlreadyExistsError();
    }
    if (isConstraintViolation(error, 'visitor_passes_active_visit_unique')) {
      throw visitorPassActiveAlreadyExistsError();
    }
    if (isConstraintViolation(error, 'visitor_passes_active_visit_check')) {
      throw visitorPassVisitNotActiveError();
    }
    if (isConstraintViolation(error, 'visitor_passes_visit_context_check')) {
      throw visitorPassBuildingMismatchError();
    }
    throw error;
  }

  return toPublicVisitorPass(record);
}

export async function getVisitorPass(
  id: string,
  userId: string,
): Promise<PublicVisitorPass> {
  const record = await visitorPassRepository.findById(id);
  if (!record) {
    throw visitorPassNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicVisitorPass(record);
}

export async function listVisitorPasses(
  filters: VisitorPassListFilters,
  userId: string,
): Promise<PublicVisitorPass[]> {
  let buildingIds: string[];
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    buildingIds = [filters.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const records = await visitorPassRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return records.map(toPublicVisitorPass);
}

export async function returnVisitorPass(
  id: string,
  input: ReturnVisitorPassInput,
  userId: string,
): Promise<PublicVisitorPass> {
  const existing = await visitorPassRepository.findById(id);
  if (!existing) {
    throw visitorPassNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status !== 'ACTIVE') {
    throw visitorPassNotActiveError();
  }
  if (input.returnedAt) {
    const returnedAt = new Date(input.returnedAt).getTime();
    if (
      returnedAt > Date.now() ||
      returnedAt < existing.issuedAt.getTime()
    ) {
      throw visitorPassReturnTimeInvalidError();
    }
  }

  const returned = await visitorPassRepository.markReturned(id, {
    returnedAt: input.returnedAt ?? null,
    returnedByUserId: input.returnedByUserId,
  });
  if (!returned) {
    throw visitorPassNotActiveError();
  }
  return toPublicVisitorPass(returned);
}

export async function cancelVisitorPass(
  id: string,
  userId: string,
): Promise<PublicVisitorPass> {
  const existing = await visitorPassRepository.findById(id);
  if (!existing) {
    throw visitorPassNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status !== 'ACTIVE') {
    throw visitorPassNotActiveError();
  }

  const cancelled = await visitorPassRepository.cancel(id, userId);
  if (!cancelled) {
    throw visitorPassNotActiveError();
  }
  return toPublicVisitorPass(cancelled);
}

function isConstraintViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    (candidate.code === '23505' || candidate.code === '23514') &&
    candidate.constraint === constraint
  );
}

function toPublicVisitorPass(record: VisitorPassRecord): PublicVisitorPass {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    visitCheckInId: record.visitCheckInId,
    passCode: record.passCode,
    issuedAt: record.issuedAt.toISOString(),
    issuedByUserId: record.issuedByUserId,
    status: record.status,
    returnedAt: record.returnedAt ? record.returnedAt.toISOString() : null,
    returnedByUserId: record.returnedByUserId,
    cancelledAt: record.cancelledAt ? record.cancelledAt.toISOString() : null,
    cancelledByUserId: record.cancelledByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export const visitorPassService = {
  cancelVisitorPass,
  getVisitorPass,
  issueVisitorPass,
  listVisitorPasses,
  returnVisitorPass,
};
