import { recordEvent, type AuditRequestContext } from '../audit';
import {
  clientAccessDeniedError,
  clientCodeAlreadyExistsError,
  clientNotFoundError,
} from './client.errors';
import type { ClientListQuery } from './client.repository';
import { clientRepository } from './client.repository';
import { normalizeClientCode } from './client.validation';
import {
  isClientInScope,
  isClientStatus,
  scopeToClientIds,
  type ClientListFilters,
  type ClientReadScope,
  type CreateClientInput,
  type NewClient,
  type PublicClient,
  type ClientRecord,
  type UpdateClientInput,
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

/**
 * `clients_code_unique` is the authoritative duplicate guard. The service
 * keeps its friendly pre-check, but a concurrent create can still lose the
 * race — that must surface as the documented `409 CLIENT_CODE_ALREADY_EXISTS`,
 * never as a 500.
 */
function isClientCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === 'clients_code_unique';
}

export async function createClient(
  input: CreateClientInput,
  audit: AuditRequestContext = {},
): Promise<PublicClient> {
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

  let record: ClientRecord;
  try {
    record = await clientRepository.createClient(newClient);
  } catch (error) {
    if (isClientCodeUniqueViolation(error)) {
      throw clientCodeAlreadyExistsError();
    }
    throw error;
  }

  await recordEvent({
    eventType: 'CLIENT_CREATED',
    outcome: 'SUCCESS',
    userId: null,
    actorUserId: audit.actorUserId ?? null,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
    metadata: {
      clientId: record.id,
      code: record.code,
      status: record.status,
    },
  });

  return toPublicClient(record);
}

/**
 * Reads an exact Client.
 *
 * `scope` is optional: an omitted scope denotes a trusted in-process service
 * call (the same convention `buildingAssignmentService` uses for its actor).
 * HTTP callers always pass the scope resolved from the authenticated user, and
 * an out-of-reach Client is denied with `403 CLIENT_ACCESS_DENIED`.
 */
export async function getClientById(
  id: string,
  scope?: ClientReadScope,
): Promise<PublicClient> {
  const record = await clientRepository.findById(id);
  // A SaaS-only lifecycle state (PROSPECT/TRIAL/GRACE/SUSPENDED/TERMINATED)
  // belongs to the platform customer registry, not to this business registry.
  if (!record || !isClientStatus(record.status)) {
    throw clientNotFoundError();
  }
  if (!isClientInScope(scope, record.id)) {
    throw clientAccessDeniedError();
  }

  return toPublicClient(record);
}

export type ListClientsOptions = ClientListFilters & {
  scope?: ClientReadScope;
  limit?: number;
  offset?: number;
};

function toRepositoryQuery(options: ListClientsOptions = {}): ClientListQuery {
  return {
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.search === undefined ? {} : { search: options.search }),
    clientIds: scopeToClientIds(options.scope),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.offset === undefined ? {} : { offset: options.offset }),
  };
}

export async function listClients(
  options: ListClientsOptions = {},
): Promise<PublicClient[]> {
  const records = await clientRepository.listClients(toRepositoryQuery(options));
  return records.map(toPublicClient);
}

/** Total matching the same filters/scope as `listClients` (pagination meta). */
export async function countClients(
  options: ListClientsOptions = {},
): Promise<number> {
  return clientRepository.countClients(toRepositoryQuery(options));
}

export async function updateClient(
  id: string,
  input: UpdateClientInput,
  scope?: ClientReadScope,
  audit: AuditRequestContext = {},
): Promise<PublicClient> {
  const existing = await clientRepository.findById(id);
  if (!existing || !isClientStatus(existing.status)) {
    throw clientNotFoundError();
  }
  if (!isClientInScope(scope, existing.id)) {
    throw clientAccessDeniedError();
  }

  const record = await clientRepository.updateClient(id, input);
  if (!record) {
    throw clientNotFoundError();
  }

  await recordEvent({
    eventType: 'CLIENT_UPDATED',
    outcome: 'SUCCESS',
    userId: null,
    actorUserId: audit.actorUserId ?? null,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
    metadata: {
      clientId: record.id,
      code: record.code,
      status: record.status,
      changedFields: Object.keys(input).sort(),
    },
  });

  return toPublicClient(record);
}

export const clientService = {
  countClients,
  createClient,
  getClientById,
  listClients,
  updateClient,
};
