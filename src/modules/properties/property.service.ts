import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import {
  propertyCodeAlreadyExistsError,
  propertyNotFoundError,
} from './property.errors';
import { propertyRepository } from './property.repository';
import { normalizePropertyCode } from './property.validation';
import type {
  CreatePropertyInput,
  NewProperty,
  PropertyRecord,
  PropertyStatus,
  PublicProperty,
  UpdatePropertyStatusInput,
} from './property.types';

export function toPublicProperty(record: PropertyRecord): PublicProperty {
  return {
    id: record.id,
    clientId: record.clientId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
    addressLine: record.addressLine,
    city: record.city,
    province: record.province,
    postalCode: record.postalCode,
    countryCode: record.countryCode,
  };
}

export async function createProperty(input: CreatePropertyInput): Promise<PublicProperty> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  const code = normalizePropertyCode(input.code);

  const existing = await propertyRepository.findByCodeForClient(input.clientId, code);
  if (existing) {
    throw propertyCodeAlreadyExistsError();
  }

  const newProperty: NewProperty = {
    clientId: input.clientId,
    code,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
    addressLine: input.addressLine?.trim() || null,
    city: input.city?.trim() || null,
    province: input.province?.trim() || null,
    postalCode: input.postalCode?.trim() || null,
    countryCode: input.countryCode?.trim() || null,
  };

  const record = await propertyRepository.createProperty(newProperty);
  return toPublicProperty(record);
}

export async function getPropertyById(id: string): Promise<PublicProperty> {
  const record = await propertyRepository.findById(id);
  if (!record) {
    throw propertyNotFoundError();
  }
  return toPublicProperty(record);
}

export async function listProperties(clientId?: string): Promise<PublicProperty[]> {
  const records = clientId
    ? await propertyRepository.listByClient(clientId)
    : await propertyRepository.listProperties();
  return records.map(toPublicProperty);
}

export async function listPropertiesByClient(
  clientId: string,
): Promise<PublicProperty[]> {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  const records = await propertyRepository.listByClient(clientId);
  return records.map(toPublicProperty);
}

export async function updatePropertyStatus(
  id: string,
  input: UpdatePropertyStatusInput,
): Promise<PublicProperty> {
  const existing = await propertyRepository.findById(id);
  if (!existing) {
    throw propertyNotFoundError();
  }

  const status: PropertyStatus = input.status;
  const record = await propertyRepository.updateStatus(id, status);
  return toPublicProperty(record as PropertyRecord);
}

export const propertyService = {
  createProperty,
  getPropertyById,
  listProperties,
  listPropertiesByClient,
  updatePropertyStatus,
};
