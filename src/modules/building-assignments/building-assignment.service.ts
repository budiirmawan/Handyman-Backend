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

export async function createAssignment(
  userId: string,
  input: CreateUserBuildingAssignmentInput,
  assignedByUserId?: string,
): Promise<PublicUserBuildingAssignment> {
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
  return toPublicAssignment(record);
}

export async function listUserAssignments(
  userId: string,
): Promise<PublicUserBuildingAssignment[]> {
  const user = await userRepository.findById(userId);
  if (!user) {
    throw userNotFoundError();
  }
  const records = await buildingAssignmentRepository.listByUser(userId);
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
): Promise<PublicUserBuildingAssignment> {
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
  return toPublicAssignment(record as UserBuildingAssignmentRecord);
}

export const buildingAssignmentService = {
  createAssignment,
  deactivateAssignment,
  listUserAssignments,
  resolveBuildingsForUser,
  toPublicAssignment,
};
