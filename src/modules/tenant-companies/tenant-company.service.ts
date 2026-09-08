import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import {
  tenantCompanyCodeAlreadyExistsError,
  tenantCompanyNotFoundError,
} from './tenant-company.errors';
import { tenantCompanyRepository } from './tenant-company.repository';
import type {
  CreateTenantCompanyInput,
  PublicTenantCompany,
  TenantCompanyListFilters,
  TenantCompanyRecord,
  UpdateTenantCompanyInput,
} from './tenant-company.types';

function toPublic(record: TenantCompanyRecord): PublicTenantCompany {
  return { ...record, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() };
}

async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

export async function createTenantCompany(input: CreateTenantCompanyInput, userId: string): Promise<PublicTenantCompany> {
  await assertClientAccess(userId, input.clientId);
  if (await tenantCompanyRepository.findByCodeForClient(input.clientId, input.tenantCode)) {
    throw tenantCompanyCodeAlreadyExistsError();
  }
  try {
    return toPublic(await tenantCompanyRepository.create(input));
  } catch (error) {
    if (isUniqueViolation(error)) throw tenantCompanyCodeAlreadyExistsError();
    throw error;
  }
}

export async function getTenantCompany(id: string, userId: string): Promise<PublicTenantCompany> {
  const record = await tenantCompanyRepository.findById(id);
  if (!record) throw tenantCompanyNotFoundError();
  await assertClientAccess(userId, record.clientId);
  return toPublic(record);
}

export async function listTenantCompanies(clientId: string, filters: TenantCompanyListFilters, userId: string): Promise<PublicTenantCompany[]> {
  await assertClientAccess(userId, clientId);
  return (await tenantCompanyRepository.listByClient(clientId, filters)).map(toPublic);
}

export async function updateTenantCompany(id: string, input: UpdateTenantCompanyInput, userId: string): Promise<PublicTenantCompany> {
  const existing = await tenantCompanyRepository.findById(id);
  if (!existing) throw tenantCompanyNotFoundError();
  await assertClientAccess(userId, existing.clientId);
  const updated = await tenantCompanyRepository.update(id, input);
  if (!updated) throw tenantCompanyNotFoundError();
  return toPublic(updated);
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === 'tenant_companies_client_code_unique';
}

export const tenantCompanyService = { createTenantCompany, getTenantCompany, listTenantCompanies, updateTenantCompany };
