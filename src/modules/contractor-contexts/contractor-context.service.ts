import { buildingRepository } from '../buildings';
import { clientRepository } from '../clients';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { propertyRepository } from '../properties';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { tenantCompanyRepository } from '../tenant-companies';
import { tenantContractorRepository } from '../tenant-contractors';
import { tenantSpaceRepository } from '../tenant-spaces';
import { vendorBuildingRepository } from '../vendor-buildings';
import { vendorRepository } from '../vendors';
import {
  contractorContextBuildingMismatchError,
  contractorContextBuildingRequiredError,
  contractorContextInactiveError,
  contractorContextInvalidError,
} from './contractor-context.errors';
import { contractorContextRepository } from './contractor-context.repository';
import type {
  ContractorContextFilters,
  ContractorContextRecord,
  ContractorPermitEligibility,
  PublicContractorContext,
  ResolveContractorContextInput,
} from './contractor-context.types';

export function toPublicContractorContext(
  record: ContractorContextRecord,
): PublicContractorContext {
  return {
    ...record,
    effectiveFrom: record.effectiveFrom?.toISOString() ?? null,
    effectiveUntil: record.effectiveUntil?.toISOString() ?? null,
    eligibleForPermit: true,
  };
}

function isEffectiveNow(input: {
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
}): boolean {
  const now = Date.now();
  return (
    (input.effectiveFrom === null || input.effectiveFrom.getTime() <= now) &&
    (input.effectiveUntil === null || input.effectiveUntil.getTime() >= now)
  );
}

async function loadBuildingContext(
  buildingId: string,
  actorUserId: string,
): Promise<{ buildingId: string; clientId: string }> {
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  const building = await buildingRepository.findById(buildingId);
  if (!building) throw contractorContextBuildingMismatchError();
  const property = await propertyRepository.findById(building.propertyId);
  if (!property) throw contractorContextBuildingMismatchError();
  const client = await clientRepository.findById(property.clientId);
  if (!client) throw contractorContextBuildingMismatchError();
  if (building.status !== 'ACTIVE' || client.status !== 'ACTIVE') {
    throw contractorContextInactiveError();
  }
  return { buildingId: building.id, clientId: client.id };
}

async function resolveVendorOperationalContext(
  vendorId: string,
  building: { buildingId: string; clientId: string },
): Promise<{
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  vendorBuildingRelationshipId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
}> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) throw contractorContextInvalidError();
  if (vendor.clientId !== building.clientId) {
    throw contractorContextBuildingMismatchError();
  }
  if (vendor.status !== 'ACTIVE') throw contractorContextInactiveError();

  const relationship = await vendorBuildingRepository.findByVendorAndBuilding(
    vendor.id,
    building.buildingId,
  );
  if (!relationship) throw contractorContextBuildingMismatchError();
  if (relationship.status !== 'ACTIVE' || !isEffectiveNow(relationship)) {
    throw contractorContextInactiveError();
  }
  return {
    vendorId: vendor.id,
    vendorCode: vendor.vendorCode,
    vendorName: vendor.vendorName,
    vendorBuildingRelationshipId: relationship.id,
    effectiveFrom: relationship.effectiveFrom,
    effectiveUntil: relationship.effectiveUntil,
  };
}

async function resolveVendorContractor(
  input: ResolveContractorContextInput,
  actorUserId: string,
): Promise<ContractorContextRecord> {
  if (!input.buildingId) throw contractorContextBuildingRequiredError();
  const building = await loadBuildingContext(input.buildingId, actorUserId);
  const vendor = await resolveVendorOperationalContext(
    input.contractorContextId,
    building,
  );
  return {
    contractorContextType: 'VENDOR_CONTRACTOR',
    contractorContextId: vendor.vendorId,
    clientId: building.clientId,
    buildingId: building.buildingId,
    vendorId: vendor.vendorId,
    vendorCode: vendor.vendorCode,
    vendorName: vendor.vendorName,
    vendorBuildingRelationshipId: vendor.vendorBuildingRelationshipId,
    tenantCompanyId: null,
    tenantCode: null,
    tenantName: null,
    tenantContractorRelationshipId: null,
    spaceId: null,
    relationshipType: null,
    effectiveFrom: vendor.effectiveFrom,
    effectiveUntil: vendor.effectiveUntil,
    status: 'ACTIVE',
  };
}

async function resolveTenantContractor(
  input: ResolveContractorContextInput,
  actorUserId: string,
): Promise<ContractorContextRecord> {
  const relationship = await tenantContractorRepository.findById(
    input.contractorContextId,
  );
  if (!relationship) throw contractorContextInvalidError();

  // Assert access to the relationship's authoritative Building before
  // returning mismatch or status details about it.
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    relationship.buildingId,
  );
  if (input.buildingId && input.buildingId !== relationship.buildingId) {
    throw contractorContextBuildingMismatchError();
  }
  const building = await loadBuildingContext(
    relationship.buildingId,
    actorUserId,
  );
  if (relationship.clientId !== building.clientId) {
    throw contractorContextBuildingMismatchError();
  }
  if (relationship.status !== 'ACTIVE' || !isEffectiveNow(relationship)) {
    throw contractorContextInactiveError();
  }

  const tenant = await tenantCompanyRepository.findById(
    relationship.tenantCompanyId,
  );
  if (!tenant) throw contractorContextInvalidError();
  if (tenant.clientId !== building.clientId) {
    throw contractorContextBuildingMismatchError();
  }
  if (tenant.status !== 'ACTIVE') throw contractorContextInactiveError();

  const tenantBuilding = await tenantBuildingContextRepository.findActive(
    tenant.id,
    building.buildingId,
  );
  if (!tenantBuilding || !isEffectiveNow(tenantBuilding)) {
    throw contractorContextInactiveError();
  }
  if (relationship.spaceId) {
    const tenantSpace =
      await tenantSpaceRepository.findActiveByTenantBuildingAndSpace(
        tenant.id,
        building.buildingId,
        relationship.spaceId,
      );
    if (!tenantSpace || !isEffectiveNow(tenantSpace)) {
      throw contractorContextInactiveError();
    }
  }

  const vendor = await resolveVendorOperationalContext(
    relationship.contractorVendorId,
    building,
  );
  return {
    contractorContextType: 'TENANT_CONTRACTOR',
    contractorContextId: relationship.id,
    clientId: building.clientId,
    buildingId: building.buildingId,
    vendorId: vendor.vendorId,
    vendorCode: vendor.vendorCode,
    vendorName: vendor.vendorName,
    vendorBuildingRelationshipId: vendor.vendorBuildingRelationshipId,
    tenantCompanyId: tenant.id,
    tenantCode: tenant.tenantCode,
    tenantName: tenant.tenantName,
    tenantContractorRelationshipId: relationship.id,
    spaceId: relationship.spaceId,
    relationshipType: relationship.relationshipType,
    effectiveFrom: relationship.effectiveFrom,
    effectiveUntil: relationship.effectiveUntil,
    status: 'ACTIVE',
  };
}

/** Resolves and validates an existing Contractor context for Permit use. */
export async function resolveContractorContext(
  input: ResolveContractorContextInput,
  actorUserId: string,
): Promise<PublicContractorContext> {
  const record = input.contractorContextType === 'VENDOR_CONTRACTOR'
    ? await resolveVendorContractor(input, actorUserId)
    : await resolveTenantContractor(input, actorUserId);
  return toPublicContractorContext(record);
}

/** Get is deliberately the same authoritative resolution, never stale storage. */
export async function getContractorContext(
  input: ResolveContractorContextInput,
  actorUserId: string,
): Promise<PublicContractorContext> {
  return resolveContractorContext(input, actorUserId);
}

export async function listContractorContexts(
  filters: ContractorContextFilters,
  actorUserId: string,
): Promise<PublicContractorContext[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (
    await contractorContextRepository.listEligible(filters, buildingIds)
  ).map(toPublicContractorContext);
}

export async function validateContractorEligibilityForPermit(
  input: ResolveContractorContextInput,
  actorUserId: string,
): Promise<ContractorPermitEligibility> {
  return {
    eligible: true,
    contractorContext: await resolveContractorContext(input, actorUserId),
  };
}

export const contractorContextService = {
  getContractorContext,
  listContractorContexts,
  resolveContractorContext,
  toPublicContractorContext,
  validateContractorEligibilityForPermit,
};
