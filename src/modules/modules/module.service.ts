import {
  moduleCodeAlreadyExistsError,
  moduleNotFoundError,
} from './module.errors';
import { moduleRepository } from './module.repository';
import { normalizeModuleCode } from './module.validation';
import type {
  CreateModuleInput,
  ModuleRecord,
  ModuleStatus,
  NewModule,
  PublicModule,
  UpdateModuleStatusInput,
} from './module.types';

export function toPublicModule(record: ModuleRecord): PublicModule {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

export async function createModule(input: CreateModuleInput): Promise<PublicModule> {
  const newModule: NewModule = {
    code: normalizeModuleCode(input.code),
    name: input.name.trim(),
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  const existing = await moduleRepository.findByCode(newModule.code);
  if (existing) {
    throw moduleCodeAlreadyExistsError();
  }

  const record = await moduleRepository.createModule(newModule);
  return toPublicModule(record);
}

export async function getModuleById(id: string): Promise<PublicModule> {
  const record = await moduleRepository.findById(id);
  if (!record) {
    throw moduleNotFoundError();
  }
  return toPublicModule(record);
}

export async function listModules(): Promise<PublicModule[]> {
  const records = await moduleRepository.listModules();
  return records.map(toPublicModule);
}

export async function updateModuleStatus(
  id: string,
  input: UpdateModuleStatusInput,
): Promise<PublicModule> {
  const existing = await moduleRepository.findById(id);
  if (!existing) {
    throw moduleNotFoundError();
  }

  const status: ModuleStatus = input.status;
  const record = await moduleRepository.updateStatus(id, status);
  return toPublicModule(record as ModuleRecord);
}

export const moduleService = {
  createModule,
  getModuleById,
  listModules,
  updateModuleStatus,
};
