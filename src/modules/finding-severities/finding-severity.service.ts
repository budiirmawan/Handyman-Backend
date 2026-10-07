import { clientInactiveError, clientNotFoundError, clientRepository } from '../clients';
import { findingSeverityCodeAlreadyExistsError, findingSeverityNotFoundError } from './finding-severity.errors';
import { findingSeverityRepository } from './finding-severity.repository';
import type { CreateFindingSeverityInput, FindingSeverityRecord, NewFindingSeverity, PublicFindingSeverity, UpdateFindingSeverityInput, UpdateFindingSeverityStatusInput } from './finding-severity.types';

export function toPublicFindingSeverity(row: FindingSeverityRecord): PublicFindingSeverity {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export async function createFindingSeverity(input: CreateFindingSeverityInput): Promise<PublicFindingSeverity> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) throw clientNotFoundError();
  if (client.status !== 'ACTIVE') throw clientInactiveError();
  if (await findingSeverityRepository.findByCodeForClient(input.clientId, input.code)) throw findingSeverityCodeAlreadyExistsError();
  const row: NewFindingSeverity = { clientId: input.clientId, code: input.code, name: input.name, rank: input.rank, description: input.description?.trim() || null, status: input.status ?? 'ACTIVE' };
  try { return toPublicFindingSeverity(await findingSeverityRepository.create(row)); }
  catch (error) { if (isUnique(error)) throw findingSeverityCodeAlreadyExistsError(); throw error; }
}
export async function getFindingSeverityById(id: string): Promise<PublicFindingSeverity> {
  const row = await findingSeverityRepository.findById(id); if (!row) throw findingSeverityNotFoundError(); return toPublicFindingSeverity(row);
}
export async function listFindingSeveritiesByClient(clientId: string): Promise<PublicFindingSeverity[]> {
  if (!(await clientRepository.findById(clientId))) throw clientNotFoundError();
  return (await findingSeverityRepository.listByClient(clientId)).map(toPublicFindingSeverity);
}
export async function updateFindingSeverity(id: string, input: UpdateFindingSeverityInput): Promise<PublicFindingSeverity> {
  if (!(await findingSeverityRepository.findById(id))) throw findingSeverityNotFoundError();
  return toPublicFindingSeverity((await findingSeverityRepository.update(id, input)) as FindingSeverityRecord);
}
export async function updateFindingSeverityStatus(id: string, input: UpdateFindingSeverityStatusInput): Promise<PublicFindingSeverity> {
  if (!(await findingSeverityRepository.findById(id))) throw findingSeverityNotFoundError();
  return toPublicFindingSeverity((await findingSeverityRepository.updateStatus(id, input.status)) as FindingSeverityRecord);
}
function isUnique(error: unknown): boolean {
  const value = error as { code?: string; constraint?: string } | null;
  return value?.code === '23505' && value.constraint === 'finding_severity_client_code_unique';
}
export const findingSeverityService = { createFindingSeverity, getFindingSeverityById, listFindingSeveritiesByClient, toPublicFindingSeverity, updateFindingSeverity, updateFindingSeverityStatus };
