import { recordEvent, type AuditRequestContext } from '../audit';
import { contextAccessService } from '../context-access';
import { PROTECTED_ROLE_CODE } from '../users/privileged-account.guard';
import { clientRepository } from '../clients';
import {
  buildingNotAvailableError,
  userBuildingAlreadyAssignedError,
  userBuildingAssignmentNotFoundError,
} from './building-assignment.errors';
import { buildingAssignmentRepository } from './building-assignment.repository';
import {
  buildingNotFoundError,
  buildingRepository,
} from '../buildings';
import {
  userNotFoundError,
  userRepository,
} from '../users';
import { propertyRepository } from '../properties';
import type {
  CreateUserBuildingAssignmentInput,
  NewUserBuildingAssignment,
  PublicUserBuildingAssignment,
  UserBuildingAssignmentRecord,
  UserBuildingAssignmentStatus,
  UserBuildingContext,
} from './building-assignment.types';

export function toPublicAssignment(
  record: UserBuildingAssignmentRecord,
): PublicUserBuildingAssignment {
  return {
    id: record.id,
    userId: record.userId,
    buildingId: record.buildingId,
    status: record.status,
    assignedByUserId: record.assignedByUserId,
    assignedAt: record.assignedAt,
  };
}

/**
 * Owner may administer scope across the installation without acquiring any
 * Building data access; every other administrative actor is limited to the
 * exact Buildings they themselves can access (no same-Client shortcut).
 * `undefined` actor denotes a trusted in-process service call; HTTP controllers
 * always supply the authenticated actor id.
 */
async function assertActorCanManageBuilding(
  actorUserId: string | undefined,
  buildingId: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (await userRepository.hasActiveRole(actorUserId, PROTECTED_ROLE_CODE)) {
    return;
  }
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
}

export async function createAssignment(
  userId: string,
  input: CreateUserBuildingAssignmentInput,
  assignedByUserId?: string,
  audit: AuditRequestContext = {},
): Promise<PublicUserBuildingAssignment> {
  await assertActorCanManageBuilding(assignedByUserId, input.buildingId);

  const user = await userRepository.findById(userId);
  if (!user) {
    throw userNotFoundError();
  }

  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  if (building.status !== 'ACTIVE') {
    throw buildingNotAvailableError();
  }

  const existing = await buildingAssignmentRepository.findActiveByUserAndBuilding(
    userId,
    building.id,
  );
  if (existing) {
    throw userBuildingAlreadyAssignedError();
  }

  const newAssignment: NewUserBuildingAssignment = {
    userId,
    buildingId: building.id,
    status: 'ACTIVE',
    assignedByUserId: assignedByUserId ?? null,
  };

  const record = await buildingAssignmentRepository.createAssignment(newAssignment);

  await recordEvent({
    eventType: 'BUILDING_ASSIGNED',
    outcome: 'SUCCESS',
    userId,
    actorUserId: assignedByUserId ?? null,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
    metadata: {
      assignmentId: record.id,
      buildingId: building.id,
    },
  });

  return toPublicAssignment(record);
}

export async function listUserAssignments(
  userId: string,
  actorUserId?: string,
): Promise<PublicUserBuildingAssignment[]> {
  const user = await userRepository.findById(userId);
  if (!user) {
    throw userNotFoundError();
  }

  let records: UserBuildingAssignmentRecord[];
  if (
    actorUserId &&
    !(await userRepository.hasActiveRole(actorUserId, PROTECTED_ROLE_CODE))
  ) {
    const accessibleBuildingIds =
      await contextAccessService.getAccessibleBuildingIds(actorUserId);
    records = await buildingAssignmentRepository.listByUserInBuildings(
      userId,
      accessibleBuildingIds,
    );
  } else {
    records = await buildingAssignmentRepository.listByUser(userId);
  }

  return records.map(toPublicAssignment);
}

/**
 * Reusable Building-context resolver: User → ACTIVE User Building Assignments
 * → ACTIVE Buildings → Property → Client. Returns only the User's explicitly
 * assigned, active Building contexts (no implicit sibling/global access).
 */
export async function resolveBuildingsForUser(
  userId: string,
): Promise<UserBuildingContext[]> {
  const user = await userRepository.findById(userId);
  if (!user) {
    return [];
  }

  const assignments = await buildingAssignmentRepository.listActiveByUser(userId);
  const contexts: UserBuildingContext[] = [];

  for (const assignment of assignments) {
    const building = await buildingRepository.findById(assignment.buildingId);
    if (!building || building.status !== 'ACTIVE') {
      continue;
    }

    const property = await propertyRepository.findById(building.propertyId);
    const client = property
      ? await clientRepository.findById(property.clientId)
      : null;

    contexts.push({
      id: assignment.id,
      status: assignment.status,
      building: {
        id: building.id,
        code: building.code,
        name: building.name,
      },
      property: property
        ? { id: property.id, code: property.code, name: property.name }
        : null,
      client: client
        ? { id: client.id, code: client.code, name: client.name }
        : null,
    });
  }

  return contexts;
}

export async function deactivateAssignment(
  userId: string,
  buildingId: string,
  assignedByUserId?: string,
  audit: AuditRequestContext = {},
): Promise<PublicUserBuildingAssignment> {
  await assertActorCanManageBuilding(assignedByUserId, buildingId);

  const user = await userRepository.findById(userId);
  if (!user) {
    throw userNotFoundError();
  }

  const assignment = await buildingAssignmentRepository.findActiveByUserAndBuilding(
    userId,
    buildingId,
  );
  if (!assignment) {
    throw userBuildingAssignmentNotFoundError();
  }

  const status: UserBuildingAssignmentStatus = 'INACTIVE';
  const record = await buildingAssignmentRepository.updateStatus(assignment.id, status);
  const mapped = toPublicAssignment(record as UserBuildingAssignmentRecord);

  await recordEvent({
    eventType: 'BUILDING_REVOKED',
    outcome: 'SUCCESS',
    userId,
    actorUserId: assignedByUserId ?? null,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
    metadata: {
      assignmentId: assignment.id,
      buildingId,
    },
  });

  return mapped;
}

export const buildingAssignmentService = {
  createAssignment,
  deactivateAssignment,
  listUserAssignments,
  resolveBuildingsForUser,
  toPublicAssignment,
};
