import {
  propertyInactiveError,
  propertyNotFoundError,
  propertyRepository,
} from '../properties';
import {
  buildingCodeAlreadyExistsError,
  buildingNotFoundError,
} from './building.errors';
import { buildingRepository } from './building.repository';
import { normalizeBuildingCode } from './building.validation';
import type {
  BuildingRecord,
  BuildingStatus,
  CreateBuildingInput,
  NewBuilding,
  PublicBuilding,
  UpdateBuildingStatusInput,
} from './building.types';

export function toPublicBuilding(record: BuildingRecord): PublicBuilding {
  return {
    id: record.id,
    propertyId: record.propertyId,
    campusId: record.campusId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
    addressLine: record.addressLine,
    city: record.city,
    province: record.province,
    postalCode: record.postalCode,
    countryCode: record.countryCode,
    timezone: record.timezone,
  };
}

export async function createBuilding(input: CreateBuildingInput): Promise<PublicBuilding> {
  const property = await propertyRepository.findById(input.propertyId);
  if (!property) {
    throw propertyNotFoundError();
  }
  if (property.status !== 'ACTIVE') {
    throw propertyInactiveError();
  }

  const code = normalizeBuildingCode(input.code);

  const existing = await buildingRepository.findByCodeForProperty(input.propertyId, code);
  if (existing) {
    throw buildingCodeAlreadyExistsError();
  }

  const newBuilding: NewBuilding = {
    propertyId: input.propertyId,
    code,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
    addressLine: input.addressLine?.trim() || null,
    city: input.city?.trim() || null,
    province: input.province?.trim() || null,
    postalCode: input.postalCode?.trim() || null,
    countryCode: input.countryCode?.trim() || null,
    timezone: input.timezone?.trim() || null,
  };

  const record = await buildingRepository.createBuilding(newBuilding);
  return toPublicBuilding(record);
}

export async function getBuildingById(id: string): Promise<PublicBuilding> {
  const record = await buildingRepository.findById(id);
  if (!record) {
    throw buildingNotFoundError();
  }
  return toPublicBuilding(record);
}

export async function listBuildings(propertyId?: string): Promise<PublicBuilding[]> {
  const records = propertyId
    ? await buildingRepository.listByProperty(propertyId)
    : await buildingRepository.listBuildings();
  return records.map(toPublicBuilding);
}

export async function listBuildingsByProperty(
  propertyId: string,
): Promise<PublicBuilding[]> {
  const property = await propertyRepository.findById(propertyId);
  if (!property) {
    throw propertyNotFoundError();
  }
  const records = await buildingRepository.listByProperty(propertyId);
  return records.map(toPublicBuilding);
}

export async function updateBuildingStatus(
  id: string,
  input: UpdateBuildingStatusInput,
): Promise<PublicBuilding> {
  const existing = await buildingRepository.findById(id);
  if (!existing) {
    throw buildingNotFoundError();
  }

  const status: BuildingStatus = input.status;
  const record = await buildingRepository.updateStatus(id, status);
  return toPublicBuilding(record as BuildingRecord);
}

export const buildingService = {
  createBuilding,
  getBuildingById,
  listBuildings,
  listBuildingsByProperty,
  updateBuildingStatus,
};
