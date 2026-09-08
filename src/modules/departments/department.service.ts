import {
  departmentCodeAlreadyExistsError,
  departmentNotFoundError,
} from './department.errors';
import { normalizeDepartmentCode } from './department.validation';
import { departmentRepository } from './department.repository';
import type {
  CreateDepartmentInput,
  DepartmentRecord,
  NewDepartment,
  PublicDepartment,
  UpdateDepartmentInput,
} from './department.types';

export function toPublicDepartment(record: DepartmentRecord): PublicDepartment {
  return {
    id: record.id,
    organizationId: record.organizationId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

export async function createDepartment(
  input: CreateDepartmentInput,
): Promise<PublicDepartment> {
  const newDept: NewDepartment = {
    organizationId: input.organizationId,
    code: normalizeDepartmentCode(input.code),
    name: input.name.trim(),
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  const existing = await departmentRepository.findByOrganizationIdAndCode(
    newDept.organizationId,
    newDept.code,
  );
  if (existing) {
    throw departmentCodeAlreadyExistsError();
  }

  const record = await departmentRepository.createDepartment(newDept);
  return toPublicDepartment(record);
}

export async function getDepartmentById(id: string): Promise<PublicDepartment> {
  const record = await departmentRepository.findById(id);
  if (!record) {
    throw departmentNotFoundError();
  }

  return toPublicDepartment(record);
}

export async function listDepartmentsByOrganization(
  organizationId: string,
): Promise<PublicDepartment[]> {
  const records = await departmentRepository.listByOrganizationId(organizationId);
  return records.map(toPublicDepartment);
}

export async function updateDepartment(
  id: string,
  input: UpdateDepartmentInput,
): Promise<PublicDepartment> {
  const existing = await departmentRepository.findById(id);
  if (!existing) {
    throw departmentNotFoundError();
  }

  const record = await departmentRepository.updateDepartment(id, input);
  return toPublicDepartment(record as DepartmentRecord);
}

export const departmentService = {
  createDepartment,
  getDepartmentById,
  listDepartmentsByOrganization,
  updateDepartment,
};
