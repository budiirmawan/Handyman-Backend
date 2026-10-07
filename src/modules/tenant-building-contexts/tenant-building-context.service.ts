import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  buildingAccessDeniedError,
  contextAccessService,
  getAccessibleBuildingIds,
} from '../context-access';
import { propertyNotFoundError, propertyRepository } from '../properties';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import { tenantSpaceRepository } from '../tenant-spaces';
import {
  tenantBuildingClientMismatchError,
  tenantBuildingContextAlreadyActiveError,
  tenantBuildingContextNotFoundError,
  tenantBuildingContextUnavailableError,
  tenantBuildingSpaceRelationshipRequiredError,
} from './tenant-building-context.errors';
import { tenantBuildingContextRepository } from './tenant-building-context.repository';
import type {
  CreateTenantBuildingContextInput,
  NewTenantBuildingContext,
  PublicTenantBuildingContext,
  TenantBuildingContextRecord,
  TenantBuildingContextStatus,
  UpdateTenantBuildingContextInput,
} from './tenant-building-context.types';

function toPublic(record: TenantBuildingContextRecord): PublicTenantBuildingContext {
  return {
    id: record.id,
    tenantCompanyId: record.tenantCompanyId,
    buildingId: record.buildingId,
    effectiveFrom: record.effectiveFrom?.toISOString() ?? null,
    effectiveUntil: record.effectiveUntil?.toISOString() ?? null,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function assertResolvable(
  tenantCompanyId: string,
  buildingId: string,
  intendedStatus: TenantBuildingContextStatus,
  actorUserId: string,
): Promise<void> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);

  const building = await buildingRepository.findById(buildingId);
  if (!building) throw buildingNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  const property = await propertyRepository.findById(building.propertyId);
  if (!property) throw propertyNotFoundError();
  if (property.clientId !== company.clientId) {
    throw tenantBuildingClientMismatchError();
  }
  if (
    intendedStatus === 'ACTIVE' &&
    (company.status !== 'ACTIVE' || building.status !== 'ACTIVE')
  ) {
    throw tenantBuildingContextUnavailableError();
  }

  const supportingSpace =
    await tenantSpaceRepository.findActiveByTenantAndBuilding(
      tenantCompanyId,
      buildingId,
    );
  if (!supportingSpace) throw tenantBuildingSpaceRelationshipRequiredError();
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

export async function createTenantBuildingContext(
  input: CreateTenantBuildingContextInput,
  actorUserId: string,
): Promise<PublicTenantBuildingContext> {
  const status = input.status ?? 'ACTIVE';
  await assertResolvable(
    input.tenantCompanyId,
    input.buildingId,
    status,
    actorUserId,
  );
  const effectiveFrom = input.effectiveFrom ?? null;
  const effectiveUntil = input.effectiveUntil ?? null;
  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  if (
    status === 'ACTIVE' &&
    await tenantBuildingContextRepository.findActive(
      input.tenantCompanyId,
      input.buildingId,
    )
  ) {
    throw tenantBuildingContextAlreadyActiveError();
  }

  const record: NewTenantBuildingContext = {
    tenantCompanyId: input.tenantCompanyId,
    buildingId: input.buildingId,
    effectiveFrom,
    effectiveUntil,
    status,
  };
  try {
    return toPublic(await tenantBuildingContextRepository.create(record));
  } catch (error) {
    if (isActiveContextUniqueViolation(error)) {
      throw tenantBuildingContextAlreadyActiveError();
    }
    throw error;
  }
}

export async function getTenantBuildingContext(
  id: string,
  actorUserId: string,
): Promise<PublicTenantBuildingContext> {
  const record = await tenantBuildingContextRepository.findById(id);
  if (!record) throw tenantBuildingContextNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return toPublic(record);
}

export async function listTenantBuildingContexts(
  tenantCompanyId: string,
  actorUserId: string,
): Promise<PublicTenantBuildingContext[]> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (
    await tenantBuildingContextRepository.listByTenantCompany(
      tenantCompanyId,
      buildingIds,
    )
  ).map(toPublic);
}

export async function listBuildingTenantContexts(
  buildingId: string,
  actorUserId: string,
): Promise<PublicTenantBuildingContext[]> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) throw buildingNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  return (await tenantBuildingContextRepository.listByBuilding(buildingId)).map(toPublic);
}

export async function updateTenantBuildingContext(
  id: string,
  input: UpdateTenantBuildingContextInput,
  actorUserId: string,
): Promise<PublicTenantBuildingContext> {
  const existing = await tenantBuildingContextRepository.findById(id);
  if (!existing) throw tenantBuildingContextNotFoundError();
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
    await assertResolvable(
      existing.tenantCompanyId,
      existing.buildingId,
      'ACTIVE',
      actorUserId,
    );
    const active = await tenantBuildingContextRepository.findActive(
      existing.tenantCompanyId,
      existing.buildingId,
    );
    if (active && active.id !== existing.id) {
      throw tenantBuildingContextAlreadyActiveError();
    }
  }

  try {
    const updated = await tenantBuildingContextRepository.update(id, effectiveInput);
    if (!updated) throw tenantBuildingContextNotFoundError();
    return toPublic(updated);
  } catch (error) {
    if (isActiveContextUniqueViolation(error)) {
      throw tenantBuildingContextAlreadyActiveError();
    }
    throw error;
  }
}

function isActiveContextUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' &&
    candidate.constraint === 'tenant_building_contexts_active_unique';
}

export const tenantBuildingContextService = {
  createTenantBuildingContext,
  getTenantBuildingContext,
  listBuildingTenantContexts,
  listTenantBuildingContexts,
  updateTenantBuildingContext,
};
