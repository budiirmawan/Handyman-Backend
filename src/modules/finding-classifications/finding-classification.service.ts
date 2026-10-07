import { clientInactiveError, clientNotFoundError, clientRepository } from '../clients';
import {
  findingClassificationCodeAlreadyExistsError,
  findingClassificationNotFoundError,
} from './finding-classification.errors';
import { findingClassificationRepository } from './finding-classification.repository';
import type {
  CreateFindingClassificationInput,
  FindingClassificationRecord,
  NewFindingClassification,
  PublicFindingClassification,
  UpdateFindingClassificationInput,
  UpdateFindingClassificationStatusInput,
} from './finding-classification.types';

export function toPublicFindingClassification(
  row: FindingClassificationRecord,
): PublicFindingClassification {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export async function createFindingClassification(
  input: CreateFindingClassificationInput,
): Promise<PublicFindingClassification> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) throw clientNotFoundError();
  if (client.status !== 'ACTIVE') throw clientInactiveError();
  if (await findingClassificationRepository.findByCodeForClient(input.clientId, input.code)) {
    throw findingClassificationCodeAlreadyExistsError();
  }
  const row: NewFindingClassification = {
    clientId: input.clientId,
    code: input.code,
    name: input.name,
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };
  try {
    return toPublicFindingClassification(await findingClassificationRepository.create(row));
  } catch (error) {
    if (isUnique(error)) throw findingClassificationCodeAlreadyExistsError();
    throw error;
  }
}

export async function getFindingClassificationById(id: string): Promise<PublicFindingClassification> {
  const row = await findingClassificationRepository.findById(id);
  if (!row) throw findingClassificationNotFoundError();
  return toPublicFindingClassification(row);
}

export async function listFindingClassificationsByClient(clientId: string): Promise<PublicFindingClassification[]> {
  if (!(await clientRepository.findById(clientId))) throw clientNotFoundError();
  return (await findingClassificationRepository.listByClient(clientId)).map(toPublicFindingClassification);
}

export async function updateFindingClassification(
  id: string,
  input: UpdateFindingClassificationInput,
): Promise<PublicFindingClassification> {
  if (!(await findingClassificationRepository.findById(id))) throw findingClassificationNotFoundError();
  return toPublicFindingClassification((await findingClassificationRepository.update(id, input)) as FindingClassificationRecord);
}

export async function updateFindingClassificationStatus(
  id: string,
  input: UpdateFindingClassificationStatusInput,
): Promise<PublicFindingClassification> {
  if (!(await findingClassificationRepository.findById(id))) throw findingClassificationNotFoundError();
  return toPublicFindingClassification((await findingClassificationRepository.updateStatus(id, input.status)) as FindingClassificationRecord);
}

function isUnique(error: unknown): boolean {
  const value = error as { code?: string; constraint?: string } | null;
  return value?.code === '23505' && value.constraint === 'finding_classification_client_code_unique';
}

export const findingClassificationService = {
  createFindingClassification,
  getFindingClassificationById,
  listFindingClassificationsByClient,
  toPublicFindingClassification,
  updateFindingClassification,
  updateFindingClassificationStatus,
};
