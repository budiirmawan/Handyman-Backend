import { AppError } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { tenantChargeRepository } from '../tenant-charges';
import { tenantCompanyNotFoundError, tenantCompanyRepository } from '../tenant-companies';
import { tenantSpaceRepository } from '../tenant-spaces';
import {
  serviceChargeReadinessAlreadyExistsError,
  serviceChargeReadinessChargeInvalidError,
  serviceChargeReadinessContextInvalidError,
  serviceChargeReadinessNotFoundError,
  serviceChargeReadinessSpaceMismatchError,
  serviceChargeReadinessStatusMismatchError,
} from './service-charge-readiness.errors';
import { serviceChargeReadinessRepository } from './service-charge-readiness.repository';
import type {
  CreateServiceChargeReadinessInput,
  NewServiceChargeReadiness,
  PublicServiceChargeReadiness,
  ServiceChargeReadinessFilters,
  ServiceChargeReadinessRecord,
  ServiceChargeReadinessStatus,
  UpdateServiceChargeReadinessInput,
} from './service-charge-readiness.types';

function toPublic(record: ServiceChargeReadinessRecord): PublicServiceChargeReadiness {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
export function resolveServiceChargeReadiness(input: {
  chargeBasis: string | null;
  tenantChargeId: string | null;
}): ServiceChargeReadinessStatus {
  if (!input.chargeBasis) return 'INCOMPLETE';
  if (!input.tenantChargeId) return 'NOT_READY';
  return 'READY';
}
async function assertContext(
  tenantCompanyId: string,
  buildingId: string,
  spaceId: string,
  actorUserId: string,
): Promise<string> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  if (!(await contextAccessService.canAccessClient(actorUserId, company.clientId))) {
    throw buildingAccessDeniedError();
  }
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  if (company.status !== 'ACTIVE' ||
      !(await tenantBuildingContextRepository.findActive(tenantCompanyId, buildingId))) {
    throw serviceChargeReadinessContextInvalidError();
  }
  if (!(await tenantSpaceRepository.findActiveByTenantBuildingAndSpace(
    tenantCompanyId, buildingId, spaceId,
  ))) {
    throw serviceChargeReadinessSpaceMismatchError();
  }
  return company.clientId;
}
async function validateCharge(input: {
  tenantChargeId: string | null;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string;
  serviceChargeType: string;
  effectiveFrom: string;
  effectiveTo: string;
}): Promise<void> {
  if (!input.tenantChargeId) return;
  const charge = await tenantChargeRepository.findById(input.tenantChargeId);
  if (!charge || charge.tenantCompanyId !== input.tenantCompanyId ||
      charge.buildingId !== input.buildingId || charge.spaceId !== input.spaceId ||
      charge.chargeType !== input.serviceChargeType || charge.status !== 'ACTIVE' ||
      charge.chargeDate < input.effectiveFrom || charge.chargeDate > input.effectiveTo) {
    throw serviceChargeReadinessChargeInvalidError();
  }
}
function assertPeriod(effectiveFrom: string, effectiveTo: string): void {
  if (effectiveTo < effectiveFrom) {
    throw AppError.validation('Request validation failed.', [
      { field: 'effectiveTo', message: 'effectiveTo must be the same as or after effectiveFrom.' },
    ]);
  }
}
function assertRequestedStatus(
  requested: ServiceChargeReadinessStatus | undefined,
  resolved: ServiceChargeReadinessStatus,
): void {
  if (requested !== undefined && requested !== resolved) {
    throw serviceChargeReadinessStatusMismatchError();
  }
}
async function loadAccessible(id: string, actorUserId: string): Promise<ServiceChargeReadinessRecord> {
  const record = await serviceChargeReadinessRepository.findById(id);
  if (!record) throw serviceChargeReadinessNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return record;
}

export async function createServiceChargeReadiness(
  input: CreateServiceChargeReadinessInput,
  actorUserId: string,
): Promise<PublicServiceChargeReadiness> {
  const clientId = await assertContext(
    input.tenantCompanyId, input.buildingId, input.spaceId, actorUserId,
  );
  const chargeBasis = input.chargeBasis?.trim() || null;
  const tenantChargeId = input.tenantChargeId ?? null;
  assertPeriod(input.effectiveFrom, input.effectiveTo);
  await validateCharge({
    tenantChargeId, tenantCompanyId: input.tenantCompanyId,
    buildingId: input.buildingId, spaceId: input.spaceId,
    serviceChargeType: input.serviceChargeType,
    effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo,
  });
  const readinessStatus = resolveServiceChargeReadiness({ chargeBasis, tenantChargeId });
  assertRequestedStatus(input.readinessStatus, readinessStatus);
  const payload: NewServiceChargeReadiness = {
    clientId,
    tenantCompanyId: input.tenantCompanyId,
    buildingId: input.buildingId,
    spaceId: input.spaceId,
    serviceChargeType: input.serviceChargeType,
    chargeBasis,
    tenantChargeId,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    readinessStatus,
    notes: input.notes?.trim() || null,
    evaluatedByUserId: actorUserId,
  };
  try {
    const record = await serviceChargeReadinessRepository.create(payload);
    await recordOperationalEvent({
      clientId, buildingId: record.buildingId,
      eventType: 'SERVICE_CHARGE_READINESS_CREATED',
      entityType: 'SERVICE_CHARGE_READINESS', entityId: record.id,
      actorUserId, summary: `Service Charge Readiness resolved ${record.readinessStatus}.`,
      metadata: { tenantCompanyId: record.tenantCompanyId, spaceId: record.spaceId,
        tenantChargeId: record.tenantChargeId },
    });
    return toPublic(record);
  } catch (error) {
    if (isUniqueViolation(error)) throw serviceChargeReadinessAlreadyExistsError();
    throw error;
  }
}
export async function getServiceChargeReadiness(
  id: string,
  actorUserId: string,
): Promise<PublicServiceChargeReadiness> {
  return toPublic(await loadAccessible(id, actorUserId));
}
export async function listServiceChargeReadiness(
  filters: ServiceChargeReadinessFilters,
  actorUserId: string,
): Promise<PublicServiceChargeReadiness[]> {
  if (filters.buildingId) await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
  return (await serviceChargeReadinessRepository.list(filters, buildingIds)).map(toPublic);
}
export async function updateServiceChargeReadiness(
  id: string,
  input: UpdateServiceChargeReadinessInput,
  actorUserId: string,
): Promise<PublicServiceChargeReadiness> {
  const current = await loadAccessible(id, actorUserId);
  await assertContext(current.tenantCompanyId, current.buildingId, current.spaceId, actorUserId);
  const serviceChargeType = input.serviceChargeType ?? current.serviceChargeType;
  const chargeBasis = input.chargeBasis === undefined ? current.chargeBasis : input.chargeBasis;
  const tenantChargeId = input.tenantChargeId === undefined ? current.tenantChargeId : input.tenantChargeId;
  const effectiveFrom = input.effectiveFrom ?? current.effectiveFrom;
  const effectiveTo = input.effectiveTo ?? current.effectiveTo;
  assertPeriod(effectiveFrom, effectiveTo);
  await validateCharge({
    tenantChargeId, tenantCompanyId: current.tenantCompanyId,
    buildingId: current.buildingId, spaceId: current.spaceId,
    serviceChargeType, effectiveFrom, effectiveTo,
  });
  const readinessStatus = resolveServiceChargeReadiness({ chargeBasis, tenantChargeId });
  assertRequestedStatus(input.readinessStatus, readinessStatus);
  try {
    const record = await serviceChargeReadinessRepository.update(id, {
      ...input, readinessStatus,
    }, actorUserId);
    if (!record) throw serviceChargeReadinessNotFoundError();
    await recordOperationalEvent({
      clientId: record.clientId, buildingId: record.buildingId,
      eventType: 'SERVICE_CHARGE_READINESS_UPDATED',
      entityType: 'SERVICE_CHARGE_READINESS', entityId: record.id,
      actorUserId, summary: `Service Charge Readiness resolved ${record.readinessStatus}.`,
      metadata: { changedFields: Object.keys(input), tenantChargeId: record.tenantChargeId },
    });
    return toPublic(record);
  } catch (error) {
    if (isUniqueViolation(error)) throw serviceChargeReadinessAlreadyExistsError();
    throw error;
  }
}

export const serviceChargeReadinessService = {
  createServiceChargeReadiness,
  getServiceChargeReadiness,
  listServiceChargeReadiness,
  resolveServiceChargeReadiness,
  updateServiceChargeReadiness,
};
