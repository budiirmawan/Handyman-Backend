import {
  departmentInactiveError,
  departmentNotFoundError,
  departmentRepository,
} from '../departments';
import {
  organizationInactiveError,
  organizationNotFoundError,
  organizationRepository,
} from '../organizations';
import { positionInactiveError, positionNotFoundError, positionRepository } from '../positions';
import { teamInactiveError, teamNotFoundError, teamRepository } from '../teams';
import { userNotFoundError } from '../users/user.errors';
import { userRepository } from '../users/user.repository';
import {
  workforceEmployeeCodeAlreadyExistsError,
  workforceHierarchyMismatchError,
  workforceProfileNotFoundError,
  workforceUserAlreadyLinkedError,
} from './workforce.errors';
import { workforceRepository } from './workforce.repository';
import { normalizeEmployeeCode } from './workforce.validation';
import type {
  CreateWorkforceProfileInput,
  NewWorkforceProfile,
  PublicWorkforceProfile,
  UpdateWorkforceProfileInput,
  WorkforceProfileRecord,
  WorkforceStatus,
} from './workforce.types';

export function toPublicWorkforceProfile(
  record: WorkforceProfileRecord,
): PublicWorkforceProfile {
  return {
    id: record.id,
    organizationId: record.organizationId,
    departmentId: record.departmentId,
    teamId: record.teamId,
    positionId: record.positionId,
    userId: record.userId,
    employeeCode: record.employeeCode,
    fullName: record.fullName,
    workforceType: record.workforceType,
    status: record.status,
  };
}

/**
 * Validates the full workforce hierarchy:
 *
 *   Client → Organization → Department → Team → Workforce Profile
 *                                             → Position
 *
 * `willBeActive` controls whether INACTIVE ancestors are rejected: an INACTIVE
 * parent may not host an ACTIVE profile, but an explicitly INACTIVE profile is
 * allowed to reference it (mirrors BE-03A/BE-03B semantics).
 */
async function resolveHierarchy(params: {
  organizationId: string;
  departmentId: string;
  teamId: string | null;
  positionId: string;
  willBeActive: boolean;
}): Promise<void> {
  const { organizationId, departmentId, teamId, positionId, willBeActive } = params;

  const organization = await organizationRepository.findById(organizationId);
  if (!organization) {
    throw organizationNotFoundError();
  }
  if (organization.status === 'INACTIVE' && willBeActive) {
    throw organizationInactiveError();
  }

  const department = await departmentRepository.findById(departmentId);
  if (!department) {
    throw departmentNotFoundError();
  }
  if (department.organizationId !== organizationId) {
    throw workforceHierarchyMismatchError(
      'The provided department does not belong to the specified organization.',
    );
  }
  if (department.status === 'INACTIVE' && willBeActive) {
    throw departmentInactiveError();
  }

  if (teamId !== null) {
    const team = await teamRepository.findById(teamId);
    if (!team) {
      throw teamNotFoundError();
    }
    if (team.departmentId !== departmentId) {
      throw workforceHierarchyMismatchError(
        'The provided team does not belong to the specified department.',
      );
    }
    if (team.status === 'INACTIVE' && willBeActive) {
      throw teamInactiveError();
    }
  }

  const position = await positionRepository.findById(positionId);
  if (!position) {
    throw positionNotFoundError();
  }
  if (position.organizationId !== organizationId) {
    throw workforceHierarchyMismatchError(
      'The provided position does not belong to the specified organization.',
    );
  }
  // A department-scoped Position must match the profile's department.
  if (position.departmentId !== null && position.departmentId !== departmentId) {
    throw workforceHierarchyMismatchError(
      'The provided position does not belong to the specified department.',
    );
  }
  if (position.status === 'INACTIVE' && willBeActive) {
    throw positionInactiveError();
  }
}

/**
 * Validates an optional User linkage.
 *
 * Linking is a pure *reference*: it never creates credentials, never assigns a
 * Role or Permission, and never mutates RBAC. Those remain owned by BE-01.
 */
async function assertLinkableUser(
  userId: string,
  excludeProfileId?: string,
): Promise<void> {
  const user = await userRepository.findById(userId);
  if (!user) {
    throw userNotFoundError();
  }

  const linked = await workforceRepository.findByUserId(userId);
  if (linked && linked.id !== excludeProfileId) {
    throw workforceUserAlreadyLinkedError();
  }
}

export async function createWorkforceProfile(
  input: CreateWorkforceProfileInput,
): Promise<PublicWorkforceProfile> {
  const status: WorkforceStatus = input.status ?? 'ACTIVE';
  const teamId = input.teamId ?? null;
  const userId = input.userId ?? null;

  await resolveHierarchy({
    organizationId: input.organizationId,
    departmentId: input.departmentId,
    teamId,
    positionId: input.positionId,
    willBeActive: status === 'ACTIVE',
  });

  // A Workforce Profile may exist with no User account at all.
  if (userId !== null) {
    await assertLinkableUser(userId);
  }

  const employeeCode = normalizeEmployeeCode(input.employeeCode);

  const existing = await workforceRepository.findByOrganizationIdAndEmployeeCode(
    input.organizationId,
    employeeCode,
  );
  if (existing) {
    throw workforceEmployeeCodeAlreadyExistsError();
  }

  const newProfile: NewWorkforceProfile = {
    organizationId: input.organizationId,
    departmentId: input.departmentId,
    teamId,
    positionId: input.positionId,
    userId,
    employeeCode,
    fullName: input.fullName.trim(),
    workforceType: input.workforceType ?? 'INTERNAL',
    status,
  };

  const record = await workforceRepository.createWorkforceProfile(newProfile);
  return toPublicWorkforceProfile(record);
}

export async function getWorkforceProfileById(
  id: string,
): Promise<PublicWorkforceProfile> {
  const record = await workforceRepository.findById(id);
  if (!record) {
    throw workforceProfileNotFoundError();
  }

  return toPublicWorkforceProfile(record);
}

export async function listWorkforceProfilesByOrganization(
  organizationId: string,
): Promise<PublicWorkforceProfile[]> {
  const organization = await organizationRepository.findById(organizationId);
  if (!organization) {
    throw organizationNotFoundError();
  }

  const records = await workforceRepository.listByOrganizationId(organizationId);
  return records.map(toPublicWorkforceProfile);
}

export async function listWorkforceProfilesByDepartment(
  departmentId: string,
): Promise<PublicWorkforceProfile[]> {
  const department = await departmentRepository.findById(departmentId);
  if (!department) {
    throw departmentNotFoundError();
  }

  const records = await workforceRepository.listByDepartmentId(departmentId);
  return records.map(toPublicWorkforceProfile);
}

export async function listWorkforceProfilesByTeam(
  teamId: string,
): Promise<PublicWorkforceProfile[]> {
  const team = await teamRepository.findById(teamId);
  if (!team) {
    throw teamNotFoundError();
  }

  const records = await workforceRepository.listByTeamId(teamId);
  return records.map(toPublicWorkforceProfile);
}

export async function updateWorkforceProfile(
  id: string,
  input: UpdateWorkforceProfileInput,
): Promise<PublicWorkforceProfile> {
  const existing = await workforceRepository.findById(id);
  if (!existing) {
    throw workforceProfileNotFoundError();
  }

  const departmentId = input.departmentId ?? existing.departmentId;
  const positionId = input.positionId ?? existing.positionId;
  const teamId = input.teamId === undefined ? existing.teamId : input.teamId;
  const status = input.status ?? existing.status;

  // Revalidate the whole hierarchy against the post-update shape so a partial
  // update can never leave the profile in an inconsistent combination.
  await resolveHierarchy({
    organizationId: existing.organizationId,
    departmentId,
    teamId,
    positionId,
    willBeActive: status === 'ACTIVE',
  });

  if (input.userId !== undefined && input.userId !== null) {
    await assertLinkableUser(input.userId, id);
  }

  const record = await workforceRepository.updateWorkforceProfile(id, input);
  if (!record) {
    throw workforceProfileNotFoundError();
  }

  return toPublicWorkforceProfile(record);
}

export const workforceService = {
  createWorkforceProfile,
  getWorkforceProfileById,
  listWorkforceProfilesByOrganization,
  listWorkforceProfilesByDepartment,
  listWorkforceProfilesByTeam,
  updateWorkforceProfile,
};
