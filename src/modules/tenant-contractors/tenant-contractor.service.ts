import { AppError } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { tenantCompanyNotFoundError, tenantCompanyRepository } from '../tenant-companies';
import { tenantSpaceRepository } from '../tenant-spaces';
import { vendorBuildingRepository } from '../vendor-buildings';
import { vendorNotFoundError, vendorRepository } from '../vendors';
import {
  tenantContractorAlreadyActiveError,
  tenantContractorClientMismatchError,
  tenantContractorContextInvalidError,
  tenantContractorRelationshipNotFoundError,
  tenantContractorSpaceMismatchError,
  tenantContractorVendorUnavailableError,
} from './tenant-contractor.errors';
import { tenantContractorRepository } from './tenant-contractor.repository';
import type {
  CreateTenantContractorRelationshipInput,
  NewTenantContractorRelationship,
  PublicTenantContractorRelationship,
  TenantContractorRelationshipFilters,
  TenantContractorRelationshipRecord,
  UpdateTenantContractorRelationshipInput,
} from './tenant-contractor.types';

function toPublic(
  record: TenantContractorRelationshipRecord,
): PublicTenantContractorRelationship {
  return {
    ...record,
    effectiveFrom: record.effectiveFrom?.toISOString() ?? null,
    effectiveUntil: record.effectiveUntil?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function assertRelationshipContext(
  input: {
    tenantCompanyId: string;
    contractorVendorId: string;
    buildingId: string;
    spaceId?: string | null;
  },
  actorUserId: string,
): Promise<string> {
  const company = await tenantCompanyRepository.findById(input.tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  await contextAccessService.assertBuildingAccess(actorUserId, input.buildingId);

  const buildingContext = await tenantBuildingContextRepository.findActive(
    input.tenantCompanyId,
    input.buildingId,
  );
  if (!buildingContext || company.status !== 'ACTIVE') {
    throw tenantContractorContextInvalidError();
  }

  if (input.spaceId) {
    const space = await tenantSpaceRepository.findActiveByTenantBuildingAndSpace(
      input.tenantCompanyId,
      input.buildingId,
      input.spaceId,
    );
    if (!space) throw tenantContractorSpaceMismatchError();
  }

  const vendor = await vendorRepository.findById(input.contractorVendorId);
  if (!vendor) throw vendorNotFoundError();
  if (vendor.clientId !== company.clientId) {
    throw tenantContractorClientMismatchError();
  }
  const vendorBuilding = await vendorBuildingRepository.findActiveByVendorAndBuilding(
    vendor.id,
    input.buildingId,
  );
  if (vendor.status !== 'ACTIVE' || !vendorBuilding) {
    throw tenantContractorVendorUnavailableError();
  }
  return company.clientId;
}

function assertEffectiveOrder(from: Date | null, until: Date | null): void {
  if (from && until && until < from) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'effectiveUntil',
        message: 'effectiveUntil must be the same as or after effectiveFrom.',
      },
    ]);
  }
}

export async function createTenantContractorRelationship(
  input: CreateTenantContractorRelationshipInput,
  actorUserId: string,
): Promise<PublicTenantContractorRelationship> {
  const clientId = await assertRelationshipContext(input, actorUserId);
  const effectiveFrom = input.effectiveFrom ?? null;
  const effectiveUntil = input.effectiveUntil ?? null;
  assertEffectiveOrder(effectiveFrom, effectiveUntil);
  const status = input.status ?? 'ACTIVE';
  const duplicateInput = {
    tenantCompanyId: input.tenantCompanyId,
    contractorVendorId: input.contractorVendorId,
    buildingId: input.buildingId,
    spaceId: input.spaceId ?? null,
    relationshipType: input.relationshipType,
  };
  if (
    status === 'ACTIVE' &&
    await tenantContractorRepository.findActiveDuplicate(duplicateInput)
  ) {
    throw tenantContractorAlreadyActiveError();
  }

  const record: NewTenantContractorRelationship = {
    clientId,
    ...duplicateInput,
    effectiveFrom,
    effectiveUntil,
    status,
    notes: input.notes ?? null,
  };
  try {
    return toPublic(await tenantContractorRepository.create(record));
  } catch (error) {
    if (isActiveUnique(error)) throw tenantContractorAlreadyActiveError();
    throw error;
  }
}

export async function getTenantContractorRelationship(
  id: string,
  actorUserId: string,
): Promise<PublicTenantContractorRelationship> {
  const record = await tenantContractorRepository.findById(id);
  if (!record) throw tenantContractorRelationshipNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return toPublic(record);
}

async function listRelationships(
  filters: TenantContractorRelationshipFilters,
  actorUserId: string,
): Promise<PublicTenantContractorRelationship[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (await tenantContractorRepository.list(filters, buildingIds)).map(toPublic);
}

export async function listTenantContractorRelationships(
  tenantCompanyId: string,
  filters: TenantContractorRelationshipFilters,
  actorUserId: string,
): Promise<PublicTenantContractorRelationship[]> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  return listRelationships({ ...filters, tenantCompanyId }, actorUserId);
}

export async function listBuildingContractorRelationships(
  buildingId: string,
  filters: TenantContractorRelationshipFilters,
  actorUserId: string,
): Promise<PublicTenantContractorRelationship[]> {
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  return listRelationships({ ...filters, buildingId }, actorUserId);
}

export async function listContractorTenantRelationships(
  contractorVendorId: string,
  filters: TenantContractorRelationshipFilters,
  actorUserId: string,
): Promise<PublicTenantContractorRelationship[]> {
  const vendor = await vendorRepository.findById(contractorVendorId);
  if (!vendor) throw vendorNotFoundError();
  await assertClientAccess(actorUserId, vendor.clientId);
  return listRelationships({ ...filters, contractorVendorId }, actorUserId);
}

export async function updateTenantContractorRelationship(
  id: string,
  input: UpdateTenantContractorRelationshipInput,
  actorUserId: string,
): Promise<PublicTenantContractorRelationship> {
  const existing = await tenantContractorRepository.findById(id);
  if (!existing) throw tenantContractorRelationshipNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, existing.buildingId);

  const effectiveInput = { ...input };
  if (
    input.status === 'INACTIVE' &&
    existing.status === 'ACTIVE' &&
    input.effectiveUntil === undefined
  ) {
    effectiveInput.effectiveUntil = new Date();
  }
  const effectiveFrom = effectiveInput.effectiveFrom === undefined
    ? existing.effectiveFrom
    : effectiveInput.effectiveFrom;
  const effectiveUntil = effectiveInput.effectiveUntil === undefined
    ? existing.effectiveUntil
    : effectiveInput.effectiveUntil;
  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
    await assertRelationshipContext(existing, actorUserId);
    const duplicate = await tenantContractorRepository.findActiveDuplicate(existing);
    if (duplicate && duplicate.id !== existing.id) {
      throw tenantContractorAlreadyActiveError();
    }
  }

  try {
    const updated = await tenantContractorRepository.update(id, effectiveInput);
    if (!updated) throw tenantContractorRelationshipNotFoundError();
    return toPublic(updated);
  } catch (error) {
    if (isActiveUnique(error)) throw tenantContractorAlreadyActiveError();
    throw error;
  }
}

function isActiveUnique(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' &&
    candidate.constraint === 'tenant_contractor_active_context_unique';
}

export const tenantContractorService = {
  createTenantContractorRelationship,
  getTenantContractorRelationship,
  listBuildingContractorRelationships,
  listContractorTenantRelationships,
  listTenantContractorRelationships,
  updateTenantContractorRelationship,
};
