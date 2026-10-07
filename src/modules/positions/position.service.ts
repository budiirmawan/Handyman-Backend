import {
  departmentInactiveError,
  departmentNotFoundError,
} from '../departments';
import { organizationInactiveError, organizationNotFoundError } from '../organizations';
import {
  positionCodeAlreadyExistsError,
  positionHierarchyMismatchError,
  positionNotFoundError,
} from './position.errors';
import { normalizePositionCode } from './position.validation';
import { positionRepository } from './position.repository';
import { organizationRepository } from '../organizations';
import type {
  CreatePositionInput,
  NewPosition,
  PositionRecord,
  PositionStatus,
  PublicPosition,
  UpdatePositionInput,
} from './position.types';

export function toPublicPosition(record: PositionRecord): PublicPosition {
  return {
    id: record.id,
    organizationId: record.organizationId,
    departmentId: record.departmentId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

export async function createPosition(input: CreatePositionInput): Promise<PublicPosition> {
  const org = await organizationRepository.findById(input.organizationId);
  if (!org) {
    throw organizationNotFoundError();
  }

  // Resolve departmentId: null means organization-level position
  let departmentId: string | null = null;

  if (input.departmentId !== undefined && input.departmentId !== null) {
    const { departmentRepository } = await import('../departments');
    const dept = await departmentRepository.findById(input.departmentId);
    if (!dept) {
      throw departmentNotFoundError();
    }

    // Enforce: department must belong to the specified organization
    if (dept.organizationId !== input.organizationId) {
      throw positionHierarchyMismatchError();
    }

    // INACTIVE departments cannot host new ACTIVE positions
    if (
      dept.status === 'INACTIVE' &&
      (input.status === undefined || input.status === 'ACTIVE')
    ) {
      throw departmentInactiveError();
    }

    departmentId = dept.id;
  }

  const newPosition: NewPosition = {
    organizationId: input.organizationId,
    departmentId,
    code: normalizePositionCode(input.code),
    name: input.name.trim(),
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  const existing = await positionRepository.findByOrganizationIdAndCode(
    newPosition.organizationId,
    newPosition.code,
  );
  if (existing) {
    throw positionCodeAlreadyExistsError();
  }

  const record = await positionRepository.createPosition(newPosition);
  return toPublicPosition(record);
}

export async function getPositionById(id: string): Promise<PublicPosition> {
  const record = await positionRepository.findById(id);
  if (!record) {
    throw positionNotFoundError();
  }

  return toPublicPosition(record);
}

export async function listPositionsByOrganization(organizationId: string): Promise<PublicPosition[]> {
  const records = await positionRepository.listByOrganizationId(organizationId);
  return records.map(toPublicPosition);
}

export async function listPositionsByDepartment(departmentId: string): Promise<PublicPosition[]> {
  const records = await positionRepository.listByDepartmentId(departmentId);
  return records.map(toPublicPosition);
}

export async function updatePosition(
  id: string,
  input: UpdatePositionInput,
): Promise<PublicPosition> {
  const existing = await positionRepository.findById(id);
  if (!existing) {
    throw positionNotFoundError();
  }

  const record = await positionRepository.updatePosition(id, input);
  return toPublicPosition(record as PositionRecord);
}

export const positionService = {
  createPosition,
  getPositionById,
  listPositionsByOrganization,
  listPositionsByDepartment,
  updatePosition,
};
