import { ERROR_CODES } from '../../shared/errors';
import { assetCertificationRepository } from '../asset-certifications/asset-certification.repository';
import { assetIdentifierRepository } from '../asset-identifiers/asset-identifier.repository';
import { assetRepository } from '../assets/asset.repository';
import { contractorContextService } from '../contractor-contexts/contractor-context.service';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { equipmentProfileRepository } from '../equipment-profiles/equipment-profile.repository';
import { inspectionBindingRepository } from '../inspection-bindings/inspection-binding.repository';
import { recordOperationalEvent } from '../operational-events';
import { permitApplicationRepository } from '../permit-applications/permit-application.repository';
import { resolveCurrentPermitValidity } from '../permit-validities/permit-validity.service';
import type { PublicPermitValidity } from '../permit-validities/permit-validity.types';
import { permitRepository } from '../permits/permit.repository';
import {
  permitEquipmentAlreadyActiveError,
  permitEquipmentBuildingMismatchError,
  permitEquipmentCertificationInvalidError,
  permitEquipmentContextInvalidError,
  permitEquipmentContractorMismatchError,
  permitEquipmentDeactivateNotAllowedError,
  permitEquipmentInactiveError,
  permitEquipmentInspectionInvalidError,
  permitEquipmentInvalidError,
  permitEquipmentInvalidValidityError,
  permitEquipmentNotFoundError,
  permitEquipmentUpdateNotAllowedError,
} from './permit-equipment.errors';
import { permitEquipmentRepository } from './permit-equipment.repository';
import type {
  AddPermitEquipmentInput,
  NewPermitEquipment,
  PermitActiveEquipmentList,
  PermitEquipmentFilters,
  PermitEquipmentRecord,
  PublicPermitEquipment,
  UpdatePermitEquipmentInput,
} from './permit-equipment.types';

type OpenEquipmentContext = {
  permitId: string;
  permitApplicationId: string;
  buildingId: string;
  contractorContextType: 'TENANT_CONTRACTOR' | 'VENDOR_CONTRACTOR';
  contractorContextId: string;
  contractorVendorId: string;
  validity: PublicPermitValidity;
};

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}
function certificationValid(record: PermitEquipmentRecord, now = new Date()): boolean | null {
  if (!record.assetCertificationId) return null;
  return record.certificationStatus === 'ACTIVE' &&
    record.certificationIssueDate !== null &&
    dateKey(record.certificationIssueDate) <= dateKey(now) &&
    (record.certificationExpiryDate === null ||
      dateKey(record.certificationExpiryDate) >= dateKey(now));
}
function inspectionValid(record: PermitEquipmentRecord): boolean | null {
  if (!record.inspectionBindingId && !record.inspectionExecutionId) return null;
  return record.inspectionBindingStatus === 'ACTIVE' &&
    record.inspectionStatus === 'COMPLETED';
}
function equipmentEligible(record: PermitEquipmentRecord, now = Date.now()): boolean {
  return record.status === 'ACTIVE' &&
    record.permitValidityStatus === 'VALID' &&
    record.validFrom.getTime() <= now && record.validUntil.getTime() > now &&
    record.assetStatus === 'ACTIVE' &&
    (record.equipmentProfileId === null || record.equipmentProfileStatus === 'ACTIVE') &&
    (record.assetIdentifierId === null || record.identifierStatus === 'ACTIVE') &&
    certificationValid(record) !== false && inspectionValid(record) !== false;
}

export function toPublicPermitEquipment(record: PermitEquipmentRecord): PublicPermitEquipment {
  return {
    ...record,
    equipmentAssetReference: record.assetId,
    eligibleForActiveWork: equipmentEligible(record),
    certificationCurrentlyValid: certificationValid(record),
    inspectionCurrentlyValid: inspectionValid(record),
    certificationIssueDate: record.certificationIssueDate
      ? dateKey(record.certificationIssueDate) : null,
    certificationExpiryDate: record.certificationExpiryDate
      ? dateKey(record.certificationExpiryDate) : null,
    validFrom: record.validFrom.toISOString(),
    validUntil: record.validUntil.toISOString(),
    deactivatedAt: record.deactivatedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function permitContextId(permit: { contractorVendorId: string; tenantContractorRelationshipId: string | null }): string {
  return permit.tenantContractorRelationshipId ?? permit.contractorVendorId;
}

async function assertContractor(input: {
  contractorContextType: 'TENANT_CONTRACTOR' | 'VENDOR_CONTRACTOR';
  contractorContextId: string;
  buildingId: string;
}, actorUserId: string): Promise<void> {
  try {
    await contractorContextService.resolveContractorContext(input, actorUserId);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? error.code : undefined;
    if (code === ERROR_CODES.CONTRACTOR_CONTEXT_INVALID ||
        code === ERROR_CODES.CONTRACTOR_CONTEXT_INACTIVE ||
        code === ERROR_CODES.CONTRACTOR_CONTEXT_BUILDING_MISMATCH ||
        code === ERROR_CODES.CONTRACTOR_CONTEXT_BUILDING_REQUIRED) {
      throw permitEquipmentContractorMismatchError();
    }
    throw error;
  }
}

async function loadOpenContext(
  permitId: string,
  applicationId: string,
  buildingId: string,
  contractorContextType: AddPermitEquipmentInput['contractorContextType'],
  contractorContextId: string,
  actorUserId: string,
): Promise<OpenEquipmentContext> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitEquipmentContextInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  if (buildingId !== permit.buildingId) throw permitEquipmentBuildingMismatchError();
  const expectedContextId = permitContextId(permit);
  if (contractorContextType !== permit.contractorContextType ||
      contractorContextId !== expectedContextId) {
    throw permitEquipmentContractorMismatchError();
  }
  const application = await permitApplicationRepository.findById(applicationId);
  if (!application || application.permitId !== permit.id || application.status !== 'SUBMITTED') {
    throw permitEquipmentContextInvalidError();
  }
  const state = await resolveCurrentPermitValidity(permit.id, actorUserId);
  const validity = state.currentValidity;
  if (!validity || (validity.status !== 'PENDING' && validity.status !== 'VALID')) {
    throw permitEquipmentContextInvalidError();
  }
  await assertContractor({
    contractorContextType: permit.contractorContextType,
    contractorContextId: expectedContextId,
    buildingId: permit.buildingId,
  }, actorUserId);
  return {
    permitId: permit.id,
    permitApplicationId: application.id,
    buildingId: permit.buildingId,
    contractorContextType: permit.contractorContextType,
    contractorContextId: expectedContextId,
    contractorVendorId: permit.contractorVendorId,
    validity,
  };
}

function resolvePeriod(input: { validFrom?: Date; validUntil?: Date }, validity: PublicPermitValidity) {
  const permitFrom = new Date(validity.validFrom);
  const permitUntil = new Date(validity.validUntil);
  const validFrom = input.validFrom ?? permitFrom;
  const validUntil = input.validUntil ?? permitUntil;
  if (validUntil <= validFrom || validFrom < permitFrom || validUntil > permitUntil) {
    throw permitEquipmentInvalidValidityError();
  }
  return { validFrom, validUntil };
}

async function resolveAssetReferences(input: {
  assetId: string;
  equipmentProfileId?: string | null;
  assetIdentifierId?: string | null;
  assetCertificationId?: string | null;
  inspectionBindingId?: string | null;
  inspectionExecutionId?: string | null;
  buildingId: string;
  clientId?: string;
  validFrom: Date;
  validUntil: Date;
}) {
  const asset = await assetRepository.findById(input.assetId);
  if (!asset) throw permitEquipmentInvalidError();
  if (asset.buildingId !== input.buildingId) throw permitEquipmentBuildingMismatchError();
  if (asset.status !== 'ACTIVE') throw permitEquipmentInactiveError();

  const profile = await equipmentProfileRepository.findByAssetId(asset.id);
  if (input.equipmentProfileId && input.equipmentProfileId !== profile?.id) {
    throw permitEquipmentInvalidError();
  }
  if (profile && profile.status !== 'ACTIVE') throw permitEquipmentInactiveError();

  let identifier = null;
  if (input.assetIdentifierId !== undefined && input.assetIdentifierId !== null) {
    identifier = await assetIdentifierRepository.findById(input.assetIdentifierId);
    if (!identifier || identifier.assetId !== asset.id) throw permitEquipmentInvalidError();
    if (identifier.status !== 'ACTIVE') throw permitEquipmentInactiveError();
  } else if (input.assetIdentifierId === undefined) {
    identifier = (await assetIdentifierRepository.listByAssetId(asset.id, { status: 'ACTIVE' }))[0] ?? null;
  }

  let certification = null;
  if (input.assetCertificationId) {
    certification = await assetCertificationRepository.findById(input.assetCertificationId);
    if (!certification || certification.assetId !== asset.id || certification.status !== 'ACTIVE') {
      throw permitEquipmentCertificationInvalidError();
    }
    if (dateKey(certification.issueDate) > dateKey(input.validFrom) ||
        (certification.expiryDate && dateKey(certification.expiryDate) < dateKey(input.validUntil))) {
      throw permitEquipmentCertificationInvalidError();
    }
  }

  let inspectionBinding = null;
  let inspectionExecutionId: string | null = null;
  if (input.inspectionBindingId || input.inspectionExecutionId) {
    if (!input.inspectionBindingId || !input.inspectionExecutionId) {
      throw permitEquipmentInspectionInvalidError();
    }
    inspectionBinding = await inspectionBindingRepository.findById(input.inspectionBindingId);
    const execution = await inspectionBindingRepository.findExecutionContext(input.inspectionExecutionId);
    if (!inspectionBinding || inspectionBinding.assetId !== asset.id ||
        inspectionBinding.buildingId !== asset.buildingId || inspectionBinding.status !== 'ACTIVE' ||
        !execution || execution.inspection_binding_id !== inspectionBinding.id ||
        execution.asset_id !== asset.id || execution.execution_status !== 'COMPLETED') {
      throw permitEquipmentInspectionInvalidError();
    }
    inspectionExecutionId = input.inspectionExecutionId;
  }
  return {
    asset,
    equipmentProfileId: profile?.id ?? null,
    assetIdentifierId: identifier?.id ?? null,
    assetCertificationId: certification?.id ?? null,
    inspectionBindingId: inspectionBinding?.id ?? null,
    inspectionExecutionId,
  };
}

function isUnique(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const item = error as { code?: string; constraint?: string };
  return item.code === '23505' && item.constraint === 'permit_equipment_active_unique';
}

export async function addPermitEquipment(
  permitId: string,
  input: AddPermitEquipmentInput,
  actorUserId: string,
): Promise<PublicPermitEquipment> {
  const context = await loadOpenContext(
    permitId, input.permitApplicationId, input.buildingId,
    input.contractorContextType, input.contractorContextId, actorUserId,
  );
  const period = resolvePeriod(input, context.validity);
  const refs = await resolveAssetReferences({ ...input, ...period, buildingId: context.buildingId });
  if (await permitEquipmentRepository.findActiveDuplicate(context.permitApplicationId, refs.asset.id)) {
    throw permitEquipmentAlreadyActiveError();
  }
  const equipment: NewPermitEquipment = {
    permitApplicationId: context.permitApplicationId,
    assetId: refs.asset.id,
    equipmentProfileId: refs.equipmentProfileId,
    assetIdentifierId: refs.assetIdentifierId,
    assetCertificationId: refs.assetCertificationId,
    inspectionBindingId: refs.inspectionBindingId,
    inspectionExecutionId: refs.inspectionExecutionId,
    ...period,
    notes: input.notes ?? null,
    actorUserId,
  };
  try {
    const created = await permitEquipmentRepository.create(equipment);
    await recordEquipmentEvent(created, actorUserId, 'PERMIT_EQUIPMENT_ADDED', 'Equipment added to Permit');
    return toPublicPermitEquipment(created);
  } catch (error) {
    if (isUnique(error)) throw permitEquipmentAlreadyActiveError();
    throw error;
  }
}

export async function getPermitEquipment(id: string, actorUserId: string): Promise<PublicPermitEquipment> {
  const equipment = await permitEquipmentRepository.findById(id);
  if (!equipment) throw permitEquipmentNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, equipment.buildingId);
  return toPublicPermitEquipment(equipment);
}

export async function listPermitEquipment(filters: PermitEquipmentFilters, actorUserId: string): Promise<PublicPermitEquipment[]> {
  if (filters.buildingId) await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (await permitEquipmentRepository.list(filters, buildingIds)).map(toPublicPermitEquipment);
}

export async function listPermitEquipmentForPermit(permitId: string, actorUserId: string): Promise<PublicPermitEquipment[]> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitEquipmentContextInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  return listPermitEquipment({ permitId }, actorUserId);
}

export async function updatePermitEquipment(id: string, input: UpdatePermitEquipmentInput, actorUserId: string): Promise<PublicPermitEquipment> {
  const existing = await permitEquipmentRepository.findById(id);
  if (!existing) throw permitEquipmentNotFoundError();
  if (existing.status !== 'ACTIVE') throw permitEquipmentUpdateNotAllowedError();
  const context = await loadOpenContext(
    existing.permitId, existing.permitApplicationId, existing.buildingId,
    existing.contractorContextType as AddPermitEquipmentInput['contractorContextType'],
    existing.contractorContextId, actorUserId,
  );
  const period = resolvePeriod({
    validFrom: input.validFrom ?? existing.validFrom,
    validUntil: input.validUntil ?? existing.validUntil,
  }, context.validity);
  const refs = await resolveAssetReferences({
    assetId: existing.assetId,
    equipmentProfileId: existing.equipmentProfileId,
    assetIdentifierId: input.assetIdentifierId === undefined ? existing.assetIdentifierId : input.assetIdentifierId,
    assetCertificationId: input.assetCertificationId === undefined ? existing.assetCertificationId : input.assetCertificationId,
    inspectionBindingId: input.inspectionBindingId === undefined ? existing.inspectionBindingId : input.inspectionBindingId,
    inspectionExecutionId: input.inspectionExecutionId === undefined ? existing.inspectionExecutionId : input.inspectionExecutionId,
    ...period,
    buildingId: context.buildingId,
  });
  const updated = await permitEquipmentRepository.updateActive(id, {
    ...input,
    assetIdentifierId: refs.assetIdentifierId,
    assetCertificationId: refs.assetCertificationId,
    inspectionBindingId: refs.inspectionBindingId,
    inspectionExecutionId: refs.inspectionExecutionId,
    ...period,
  }, actorUserId);
  if (!updated) throw permitEquipmentUpdateNotAllowedError();
  await recordEquipmentEvent(updated, actorUserId, 'PERMIT_EQUIPMENT_UPDATED', 'Permit Equipment updated');
  return toPublicPermitEquipment(updated);
}

export async function deactivatePermitEquipment(id: string, actorUserId: string): Promise<PublicPermitEquipment> {
  const existing = await permitEquipmentRepository.findById(id);
  if (!existing) throw permitEquipmentNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, existing.buildingId);
  if (existing.status !== 'ACTIVE') throw permitEquipmentDeactivateNotAllowedError();
  const result = await permitEquipmentRepository.deactivate(id, actorUserId);
  if (!result) throw permitEquipmentDeactivateNotAllowedError();
  await recordEquipmentEvent(result, actorUserId, 'PERMIT_EQUIPMENT_DEACTIVATED', 'Permit Equipment deactivated');
  return toPublicPermitEquipment(result);
}

export async function resolveActivePermitEquipment(permitId: string, actorUserId: string): Promise<PermitActiveEquipmentList> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitEquipmentContextInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  const state = await resolveCurrentPermitValidity(permit.id, actorUserId);
  const validityStatus = state.currentValidity?.status ?? null;
  if (validityStatus === 'VALID') {
    await assertContractor({
      contractorContextType: permit.contractorContextType,
      contractorContextId: permitContextId(permit),
      buildingId: permit.buildingId,
    }, actorUserId);
  }
  const records = await permitEquipmentRepository.list(
    { permitId: permit.id, status: 'ACTIVE' }, [permit.buildingId],
  );
  const equipment = validityStatus === 'VALID'
    ? records.filter((item) => equipmentEligible(item)).map(toPublicPermitEquipment)
    : [];
  return {
    permitId: permit.id,
    permitReference: permit.permitNumber,
    buildingId: permit.buildingId,
    contractorContextType: permit.contractorContextType,
    contractorVendorId: permit.contractorVendorId,
    validityStatus,
    active: validityStatus === 'VALID',
    equipmentCount: equipment.length,
    equipment,
  };
}

async function recordEquipmentEvent(record: PermitEquipmentRecord, actorUserId: string, eventType: string, summary: string): Promise<void> {
  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    entityType: 'PERMIT_EQUIPMENT',
    entityId: record.id,
    eventType,
    actorUserId,
    summary,
    metadata: {
      permitId: record.permitId,
      permitApplicationId: record.permitApplicationId,
      contractorVendorId: record.contractorVendorId,
      assetId: record.assetId,
      equipmentProfileId: record.equipmentProfileId,
      certificationId: record.assetCertificationId,
      inspectionExecutionId: record.inspectionExecutionId,
      status: record.status,
    },
  });
}

export const permitEquipmentService = {
  addPermitEquipment,
  deactivatePermitEquipment,
  getPermitEquipment,
  listPermitEquipment,
  listPermitEquipmentForPermit,
  resolveActivePermitEquipment,
  toPublicPermitEquipment,
  updatePermitEquipment,
};
