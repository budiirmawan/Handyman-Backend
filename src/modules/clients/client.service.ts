import {
  clientCodeAlreadyExistsError,
  clientNotFoundError,
} from './client.errors';
import { clientRepository } from './client.repository';
import { normalizeClientCode } from './client.validation';
import type {
  CreateClientInput,
  NewClient,
  PublicClient,
  ClientRecord,
  UpdateClientInput,
} from './client.types';

export function toPublicClient(record: ClientRecord): PublicClient {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    legalName: record.legalName,
    taxId: record.taxId,
    description: record.description,
    status: record.status,
  };
}

export async function createClient(input: CreateClientInput): Promise<PublicClient> {
  const newClient: NewClient = {
    code: normalizeClientCode(input.code),
    name: input.name.trim(),
    legalName: input.legalName?.trim() || null,
    taxId: input.taxId?.trim() || null,
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  const existing = await clientRepository.findByCode(newClient.code);
  if (existing) {
    throw clientCodeAlreadyExistsError();
  }

  const record = await clientRepository.createClient(newClient);
  return toPublicClient(record);
}

export async function getClientById(id: string): Promise<PublicClient> {
  const record = await clientRepository.findById(id);
  if (!record) {
    throw clientNotFoundError();
  }

  return toPublicClient(record);
}

export async function listClients(): Promise<PublicClient[]> {
  const records = await clientRepository.listClients();
  return records.map(toPublicClient);
}

export async function updateClient(
  id: string,
  input: UpdateClientInput,
): Promise<PublicClient> {
  const existing = await clientRepository.findById(id);
  if (!existing) {
    throw clientNotFoundError();
  }

  const record = await clientRepository.updateClient(id, input);
  return toPublicClient(record as ClientRecord);
}

export const clientService = {
  createClient,
  getClientById,
  listClients,
  updateClient,
};
