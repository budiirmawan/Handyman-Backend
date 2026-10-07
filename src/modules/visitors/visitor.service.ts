import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access';
import {
  visitorIdentityAlreadyExistsError,
  visitorIdentityNumberRequiresTypeError,
  visitorNotFoundError,
} from './visitor.errors';
import { visitorRepository } from './visitor.repository';
import type {
  CreateVisitorInput,
  PublicVisitor,
  UpdateVisitorInput,
  VisitorListFilters,
  VisitorRecord,
} from './visitor.types';

/**
 * BE-13A — Visitor Identity service.
 *
 * Backend authority for the single shared visitor identity master.
 * Later BE-13 PARTs (Invitation, Expected Visitor, Walk-In, Contractor,
 * Delivery / Courier) reference this identity — they never create their
 * own visitor master.
 *
 * Access rule: a caller may touch a Client's visitors only when the
 * caller has an ACTIVE Building assignment under that Client (the same
 * `canAccessClient` rule used by other Client-scoped masters). Unknown
 * Clients are denied identically to inaccessible ones so existence is
 * never leaked.
 *
 * Duplicate avoidance: a visitor identity document (identity type +
 * identity number) is unique per Client — enforced both by a pre-check
 * (clean 409) and by the partial unique index (race safety).
 */

export async function createVisitor(
  input: CreateVisitorInput,
  userId: string,
): Promise<PublicVisitor> {
  await assertClientAccess(userId, input.clientId);

  const identityType = input.identityType ?? 'NONE';
  if (input.identityNumber && identityType === 'NONE') {
    throw visitorIdentityNumberRequiresTypeError();
  }

  if (input.identityNumber) {
    const duplicate = await visitorRepository.findByClientAndIdentity(
      input.clientId,
      identityType,
      input.identityNumber,
    );
    if (duplicate) {
      throw visitorIdentityAlreadyExistsError();
    }
  }

  let record: VisitorRecord;
  try {
    record = await visitorRepository.create(input);
  } catch (error) {
    if (isUniqueViolation(error, 'visitors_client_identity_unique')) {
      throw visitorIdentityAlreadyExistsError();
    }
    throw error;
  }
  return toPublicVisitor(record);
}

export async function getVisitor(
  id: string,
  userId: string,
): Promise<PublicVisitor> {
  const record = await visitorRepository.findById(id);
  if (!record) {
    throw visitorNotFoundError();
  }
  await assertClientAccess(userId, record.clientId);
  return toPublicVisitor(record);
}

export async function listVisitors(
  clientId: string,
  filters: VisitorListFilters,
  userId: string,
): Promise<PublicVisitor[]> {
  await assertClientAccess(userId, clientId);
  const records = await visitorRepository.listByClient(clientId, filters);
  return records.map(toPublicVisitor);
}

export async function updateVisitor(
  id: string,
  input: UpdateVisitorInput,
  userId: string,
): Promise<PublicVisitor> {
  const existing = await visitorRepository.findById(id);
  if (!existing) {
    throw visitorNotFoundError();
  }
  await assertClientAccess(userId, existing.clientId);

  const nextIdentityType =
    input.identityType !== undefined ? input.identityType : existing.identityType;
  const nextIdentityNumber =
    input.identityNumber !== undefined
      ? input.identityNumber
      : existing.identityNumber;

  if (nextIdentityNumber && nextIdentityType === 'NONE') {
    throw visitorIdentityNumberRequiresTypeError();
  }

  const identityChanged =
    nextIdentityNumber !== null &&
    (nextIdentityType !== existing.identityType ||
      nextIdentityNumber !== existing.identityNumber);

  if (identityChanged && nextIdentityNumber) {
    const duplicate = await visitorRepository.findByClientAndIdentity(
      existing.clientId,
      nextIdentityType,
      nextIdentityNumber,
    );
    if (duplicate && duplicate.id !== id) {
      throw visitorIdentityAlreadyExistsError();
    }
  }

  let updated: VisitorRecord | null;
  try {
    updated = await visitorRepository.update(id, input);
  } catch (error) {
    if (isUniqueViolation(error, 'visitors_client_identity_unique')) {
      throw visitorIdentityAlreadyExistsError();
    }
    throw error;
  }
  if (!updated) {
    throw visitorNotFoundError();
  }
  return toPublicVisitor(updated);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function assertClientAccess(
  userId: string,
  clientId: string,
): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function toPublicVisitor(record: VisitorRecord): PublicVisitor {
  return {
    id: record.id,
    clientId: record.clientId,
    fullName: record.fullName,
    identityType: record.identityType,
    identityNumber: record.identityNumber,
    phone: record.phone,
    email: record.email,
    organizationName: record.organizationName,
    notes: record.notes,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export const visitorService = {
  createVisitor,
  getVisitor,
  listVisitors,
  updateVisitor,
};
