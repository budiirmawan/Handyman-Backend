import { userNotFoundError, userRepository } from '../users';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import {
  tenantCompanyInactiveForPicError,
  tenantPicInactivePrimaryError,
  tenantPicNotFoundError,
  tenantPicUserAlreadyLinkedError,
  tenantPicUserClientMismatchError,
} from './tenant-pic.errors';
import { tenantPicRepository } from './tenant-pic.repository';
import type {
  CreateTenantPicInput,
  NewTenantPic,
  PublicTenantPic,
  TenantPicRecord,
  UpdateTenantPicInput,
} from './tenant-pic.types';

function toPublic(record: TenantPicRecord): PublicTenantPic {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function assertLinkableUser(userId: string, clientId: string): Promise<void> {
  const user = await userRepository.findById(userId);
  if (!user) throw userNotFoundError();
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw tenantPicUserClientMismatchError();
  }
}

export async function createTenantPic(
  input: CreateTenantPicInput,
  actorUserId: string,
): Promise<PublicTenantPic> {
  const company = await tenantCompanyRepository.findById(input.tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  if (company.status !== 'ACTIVE') throw tenantCompanyInactiveForPicError();

  const status = input.status ?? 'ACTIVE';
  const isPrimary = input.isPrimary ?? false;
  if (isPrimary && status !== 'ACTIVE') throw tenantPicInactivePrimaryError();
  if (input.userId) await assertLinkableUser(input.userId, company.clientId);

  const record: NewTenantPic = {
    tenantCompanyId: input.tenantCompanyId,
    userId: input.userId ?? null,
    picName: input.picName,
    email: input.email ?? null,
    phone: input.phone ?? null,
    roleTitle: input.roleTitle ?? null,
    isPrimary,
    status,
  };
  try {
    return toPublic(await tenantPicRepository.create(record));
  } catch (error) {
    if (isUniqueViolation(error, 'tenant_pics_company_user_unique')) {
      throw tenantPicUserAlreadyLinkedError();
    }
    throw error;
  }
}

export async function getTenantPic(id: string, actorUserId: string): Promise<PublicTenantPic> {
  const record = await tenantPicRepository.findById(id);
  if (!record) throw tenantPicNotFoundError();
  const company = await tenantCompanyRepository.findById(record.tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  return toPublic(record);
}

export async function listTenantPics(
  tenantCompanyId: string,
  actorUserId: string,
): Promise<PublicTenantPic[]> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  return (await tenantPicRepository.listByTenantCompany(tenantCompanyId)).map(toPublic);
}

export async function updateTenantPic(
  id: string,
  input: UpdateTenantPicInput,
  actorUserId: string,
): Promise<PublicTenantPic> {
  const existing = await tenantPicRepository.findById(id);
  if (!existing) throw tenantPicNotFoundError();
  const company = await tenantCompanyRepository.findById(existing.tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);

  const resultingStatus = input.status ?? existing.status;
  if (input.isPrimary === true && resultingStatus !== 'ACTIVE') {
    throw tenantPicInactivePrimaryError();
  }
  if (input.userId) await assertLinkableUser(input.userId, company.clientId);

  const effectiveInput = { ...input };
  if (resultingStatus === 'INACTIVE' && existing.isPrimary && input.isPrimary === undefined) {
    effectiveInput.isPrimary = false;
  }

  try {
    const updated = await tenantPicRepository.update(
      id,
      existing.tenantCompanyId,
      effectiveInput,
    );
    if (!updated) throw tenantPicNotFoundError();
    return toPublic(updated);
  } catch (error) {
    if (isUniqueViolation(error, 'tenant_pics_company_user_unique')) {
      throw tenantPicUserAlreadyLinkedError();
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

export const tenantPicService = {
  createTenantPic,
  getTenantPic,
  listTenantPics,
  updateTenantPic,
};
