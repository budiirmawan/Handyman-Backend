import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  buildingAccessDeniedError,
  contextAccessService,
  getAccessibleBuildingIds,
} from '../context-access';
import { propertyNotFoundError, propertyRepository } from '../properties';
import {
  resolveRoomBuildingId,
  spaceNotFoundError,
  spaceRepository,
} from '../spaces';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import {
  tenantSpaceAlreadyAssignedError,
  tenantSpaceBuildingMismatchError,
  tenantSpaceClientMismatchError,
  tenantSpaceRelationshipNotFoundError,
  tenantSpaceUnavailableError,
} from './tenant-space.errors';
import { tenantSpaceRepository } from './tenant-space.repository';
import type {
  AssignTenantSpaceInput,
  NewTenantSpaceRelationship,
  PublicTenantSpaceRelationship,
  TenantSpaceRelationshipRecord,
  TenantSpaceRelationshipStatus,
  UpdateTenantSpaceRelationshipInput,
} from './tenant-space.types';

function toPublic(record: TenantSpaceRelationshipRecord): PublicTenantSpaceRelationship {
  return {
    id: record.id,
    tenantCompanyId: record.tenantCompanyId,
    buildingId: record.buildingId,
    spaceId: record.spaceId,
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

async function resolveBuildingClientId(buildingId: string): Promise<{
  clientId: string;
  status: string;
}> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) throw buildingNotFoundError();
  const property = await propertyRepository.findById(building.propertyId);
  if (!property) throw propertyNotFoundError();
  return { clientId: property.clientId, status: building.status };
}

async function assertValidContext(
  tenantCompanyId: string,
  buildingId: string,
  spaceId: string,
  intendedStatus: TenantSpaceRelationshipStatus,
  actorUserId: string,
): Promise<void> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);

  const building = await resolveBuildingClientId(buildingId);
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);

  const space = await spaceRepository.findById(spaceId);
  if (!space) throw spaceNotFoundError();
  const actualBuildingId = await resolveRoomBuildingId(space.roomId);
  if (actualBuildingId !== buildingId) throw tenantSpaceBuildingMismatchError();
  if (building.clientId !== company.clientId) throw tenantSpaceClientMismatchError();

  if (
    intendedStatus === 'ACTIVE' &&
    (company.status !== 'ACTIVE' || building.status !== 'ACTIVE' || space.status !== 'ACTIVE')
  ) {
    throw tenantSpaceUnavailableError();
  }
}

function assertEffectiveOrder(
  effectiveFrom: Date | null,
  effectiveUntil: Date | null,
): void {
  if (effectiveFrom && effectiveUntil && effectiveUntil < effectiveFrom) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'effectiveUntil',
        message: 'effectiveUntil must be the same as or after effectiveFrom.',
      },
    ]);
  }
}

export async function assignSpaceToTenant(
  input: AssignTenantSpaceInput,
  actorUserId: string,
): Promise<PublicTenantSpaceRelationship> {
  const status = input.status ?? 'ACTIVE';
  await assertValidContext(
    input.tenantCompanyId,
    input.buildingId,
    input.spaceId,
    status,
    actorUserId,
  );
  const effectiveFrom = input.effectiveFrom ?? null;
  const effectiveUntil = input.effectiveUntil ?? null;
  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  if (status === 'ACTIVE' && await tenantSpaceRepository.findActiveBySpace(input.spaceId)) {
    throw tenantSpaceAlreadyAssignedError();
  }

  const record: NewTenantSpaceRelationship = {
    tenantCompanyId: input.tenantCompanyId,
    buildingId: input.buildingId,
    spaceId: input.spaceId,
    effectiveFrom,
    effectiveUntil,
    status,
  };
  try {
    return toPublic(await tenantSpaceRepository.create(record));
  } catch (error) {
    if (isActiveSpaceUniqueViolation(error)) throw tenantSpaceAlreadyAssignedError();
    throw error;
  }
}

export async function getTenantSpaceRelationship(
  id: string,
  actorUserId: string,
): Promise<PublicTenantSpaceRelationship> {
  const record = await tenantSpaceRepository.findById(id);
  if (!record) throw tenantSpaceRelationshipNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return toPublic(record);
}

export async function listTenantSpaceRelationships(
  tenantCompanyId: string,
  actorUserId: string,
): Promise<PublicTenantSpaceRelationship[]> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (
    await tenantSpaceRepository.listByTenantCompany(tenantCompanyId, buildingIds)
  ).map(toPublic);
}

export async function listBuildingTenantSpaces(
  buildingId: string,
  actorUserId: string,
): Promise<PublicTenantSpaceRelationship[]> {
  await resolveBuildingClientId(buildingId);
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  return (await tenantSpaceRepository.listByBuilding(buildingId)).map(toPublic);
}

export async function updateTenantSpaceRelationship(
  id: string,
  input: UpdateTenantSpaceRelationshipInput,
  actorUserId: string,
): Promise<PublicTenantSpaceRelationship> {
  const existing = await tenantSpaceRepository.findById(id);
  if (!existing) throw tenantSpaceRelationshipNotFoundError();
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
    await assertValidContext(
      existing.tenantCompanyId,
      existing.buildingId,
      existing.spaceId,
      'ACTIVE',
      actorUserId,
    );
    const active = await tenantSpaceRepository.findActiveBySpace(existing.spaceId);
    if (active && active.id !== existing.id) throw tenantSpaceAlreadyAssignedError();
  }

  try {
    const updated = await tenantSpaceRepository.update(id, effectiveInput);
    if (!updated) throw tenantSpaceRelationshipNotFoundError();
    return toPublic(updated);
  } catch (error) {
    if (isActiveSpaceUniqueViolation(error)) throw tenantSpaceAlreadyAssignedError();
    throw error;
  }
}

function isActiveSpaceUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' &&
    candidate.constraint === 'tenant_space_relationships_active_space_unique';
}

export const tenantSpaceService = {
  assignSpaceToTenant,
  getTenantSpaceRelationship,
  listBuildingTenantSpaces,
  listTenantSpaceRelationships,
  updateTenantSpaceRelationship,
};
