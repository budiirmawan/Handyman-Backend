import {
  departmentNotFoundError,
  departmentInactiveError,
} from '../departments';
import { teamCodeAlreadyExistsError, teamNotFoundError } from './team.errors';
import { normalizeTeamCode } from './team.validation';
import { teamRepository } from './team.repository';
import type {
  CreateTeamInput,
  NewTeam,
  PublicTeam,
  TeamRecord,
  UpdateTeamInput,
} from './team.types';

export function toPublicTeam(record: TeamRecord): PublicTeam {
  return {
    id: record.id,
    departmentId: record.departmentId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

export async function createTeam(input: CreateTeamInput): Promise<PublicTeam> {
  const dept = await import('../departments').then(m => m.departmentRepository.findById(input.departmentId));
  if (!dept) {
    throw departmentNotFoundError();
  }

  // INACTIVE departments cannot host new ACTIVE teams
  if (dept.status === 'INACTIVE' && (input.status === undefined || input.status === 'ACTIVE')) {
    throw departmentInactiveError();
  }

  const newTeam: NewTeam = {
    departmentId: input.departmentId,
    code: normalizeTeamCode(input.code),
    name: input.name.trim(),
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  const existing = await teamRepository.findByDepartmentIdAndCode(
    newTeam.departmentId,
    newTeam.code,
  );
  if (existing) {
    throw teamCodeAlreadyExistsError();
  }

  const record = await teamRepository.createTeam(newTeam);
  return toPublicTeam(record);
}

export async function getTeamById(id: string): Promise<PublicTeam> {
  const record = await teamRepository.findById(id);
  if (!record) {
    throw teamNotFoundError();
  }

  return toPublicTeam(record);
}

export async function listTeamsByDepartment(departmentId: string): Promise<PublicTeam[]> {
  const records = await teamRepository.listByDepartmentId(departmentId);
  return records.map(toPublicTeam);
}

export async function updateTeam(
  id: string,
  input: UpdateTeamInput,
): Promise<PublicTeam> {
  const existing = await teamRepository.findById(id);
  if (!existing) {
    throw teamNotFoundError();
  }

  const record = await teamRepository.updateTeam(id, input);
  return toPublicTeam(record as TeamRecord);
}

export const teamService = {
  createTeam,
  getTeamById,
  listTeamsByDepartment,
  updateTeam,
};
