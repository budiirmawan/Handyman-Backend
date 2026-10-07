import {
  organizationCodeAlreadyExistsError,
  organizationNotFoundError,
} from './organization.errors';
import { normalizeOrganizationCode } from './organization.validation';
import { organizationRepository } from './organization.repository';
import type {
  CreateOrganizationInput,
  NewOrganization,
  OrganizationRecord,
  PublicOrganization,
  UpdateOrganizationInput,
} from './organization.types';

export function toPublicOrganization(record: OrganizationRecord): PublicOrganization {
  return {
    id: record.id,
    clientId: record.clientId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

export async function createOrganization(
  input: CreateOrganizationInput,
): Promise<PublicOrganization> {
  const newOrg: NewOrganization = {
    clientId: input.clientId,
    code: normalizeOrganizationCode(input.code),
    name: input.name.trim(),
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  const existing = await organizationRepository.findByClientIdAndCode(
    newOrg.clientId,
    newOrg.code,
  );
  if (existing) {
    throw organizationCodeAlreadyExistsError();
  }

  const record = await organizationRepository.createOrganization(newOrg);
  return toPublicOrganization(record);
}

export async function getOrganizationById(
  id: string,
): Promise<PublicOrganization> {
  const record = await organizationRepository.findById(id);
  if (!record) {
    throw organizationNotFoundError();
  }

  return toPublicOrganization(record);
}

export async function listOrganizationsByClient(
  clientId: string,
): Promise<PublicOrganization[]> {
  const records = await organizationRepository.listByClientId(clientId);
  return records.map(toPublicOrganization);
}

export async function updateOrganization(
  id: string,
  input: UpdateOrganizationInput,
): Promise<PublicOrganization> {
  const existing = await organizationRepository.findById(id);
  if (!existing) {
    throw organizationNotFoundError();
  }

  const record = await organizationRepository.updateOrganization(id, input);
  return toPublicOrganization(record as OrganizationRecord);
}

export const organizationService = {
  createOrganization,
  getOrganizationById,
  listOrganizationsByClient,
  updateOrganization,
};
