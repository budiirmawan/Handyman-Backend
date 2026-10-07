import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import {
  captureConfigurationVersion,
  resolveLifecycleEffectiveSnapshot,
} from '../configuration-versions';
import {
  clientConfigurationKeyAlreadyExistsError,
  clientConfigurationNotFoundError,
} from './client-configuration.errors';
import { clientConfigurationRepository } from './client-configuration.repository';
import type {
  ClientConfigurationFilters,
  ClientConfigurationRecord,
  ClientConfigurationValue,
  CreateClientConfigurationInput,
  EffectiveClientConfiguration,
  NewClientConfiguration,
  PublicClientConfiguration,
  UpdateClientConfigurationInput,
} from './client-configuration.types';

/**
 * BE-27A uses the BE-02G context resolver as its sole Client data-scope
 * authority. Permission checks remain in the existing RBAC middleware.
 */
async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

function isReservedConfigurationKey(key: string): boolean {
  return (
    key.startsWith('OPERATIONAL.') ||
    key.startsWith('PRESENTATION.') ||
    key.startsWith('BRANDING.')
  );
}

async function requireClient(clientId: string) {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  return client;
}

/** Shared BE-27 Client-scope resolver for later configuration parts. */
export async function resolveClientConfigurationContext(
  clientId: string,
  userId: string,
) {
  const client = await requireClient(clientId);
  await assertClientAccess(userId, clientId);
  return client;
}

export function toPublicClientConfiguration(
  record: ClientConfigurationRecord,
): PublicClientConfiguration {
  return {
    id: record.id,
    clientId: record.clientId,
    key: record.key,
    value: record.value,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function versionClientConfiguration(
  configuration: PublicClientConfiguration,
  userId: string,
): Promise<PublicClientConfiguration> {
  await captureConfigurationVersion(
    {
      sourceType: 'CLIENT_CONFIGURATION',
      sourceConfigurationId: configuration.id,
      clientId: configuration.clientId,
      buildingId: null,
      status: configuration.status,
      snapshot: configuration,
    },
    userId,
  );
  return configuration;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string; constraint?: string }).code === '23505' &&
    (error as { constraint?: string }).constraint ===
      'client_configurations_client_key_unique'
  );
}

export async function createClientConfiguration(
  input: CreateClientConfigurationInput,
  userId: string,
): Promise<PublicClientConfiguration> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  await assertClientAccess(userId, input.clientId);
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  const existing = await clientConfigurationRepository.findByClientAndKey(
    input.clientId,
    input.key,
  );
  if (existing) {
    throw clientConfigurationKeyAlreadyExistsError();
  }

  const next: NewClientConfiguration = {
    clientId: input.clientId,
    key: input.key,
    value: input.value,
    status: input.status ?? 'ACTIVE',
  };

  try {
    return versionClientConfiguration(
      toPublicClientConfiguration(
        await clientConfigurationRepository.create(next),
      ),
      userId,
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw clientConfigurationKeyAlreadyExistsError();
    }
    throw error;
  }
}

export async function listClientConfigurations(
  clientId: string,
  filters: ClientConfigurationFilters,
  userId: string,
  includeReserved = false,
): Promise<PublicClientConfiguration[]> {
  await requireClient(clientId);
  await assertClientAccess(userId, clientId);
  return (await clientConfigurationRepository.listByClient(clientId, filters))
    .filter(
      (record) =>
        includeReserved || !isReservedConfigurationKey(record.key),
    )
    .map(toPublicClientConfiguration);
}

export async function getClientConfigurationById(
  id: string,
  userId: string,
  includeReserved = false,
): Promise<PublicClientConfiguration> {
  const record = await clientConfigurationRepository.findById(id);
  if (
    !record ||
    (!includeReserved && isReservedConfigurationKey(record.key))
  ) {
    throw clientConfigurationNotFoundError();
  }
  await assertClientAccess(userId, record.clientId);
  return toPublicClientConfiguration(record);
}

export async function updateClientConfiguration(
  id: string,
  input: UpdateClientConfigurationInput,
  userId: string,
  includeReserved = false,
): Promise<PublicClientConfiguration> {
  const existing = await clientConfigurationRepository.findById(id);
  if (
    !existing ||
    (!includeReserved && isReservedConfigurationKey(existing.key))
  ) {
    throw clientConfigurationNotFoundError();
  }
  await assertClientAccess(userId, existing.clientId);

  const updated = await clientConfigurationRepository.update(id, input);
  if (!updated) {
    throw clientConfigurationNotFoundError();
  }
  return versionClientConfiguration(
    toPublicClientConfiguration(updated),
    userId,
  );
}

/**
 * Returns only ACTIVE key/value records for the selected accessible Client.
 * There is no Building override, entitlement projection, version, or preview
 * behavior in BE-27A.
 */
export async function getEffectiveClientConfiguration(
  clientId: string,
  userId: string,
  includeReserved = false,
): Promise<EffectiveClientConfiguration> {
  const client = await requireClient(clientId);
  await assertClientAccess(userId, clientId);
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }
  const records = await clientConfigurationRepository.listByClient(clientId);
  const configurations: Record<string, ClientConfigurationValue> = {};
  for (const record of records) {
    if (!includeReserved && isReservedConfigurationKey(record.key)) continue;
    const current = toPublicClientConfiguration(record);
    const snapshot = await resolveLifecycleEffectiveSnapshot(
      'CLIENT_CONFIGURATION',
      record.id,
      current,
    );
    if (
      typeof snapshot === 'object' &&
      snapshot !== null &&
      !Array.isArray(snapshot) &&
      snapshot.status === 'ACTIVE' &&
      typeof snapshot.key === 'string' &&
      Object.prototype.hasOwnProperty.call(snapshot, 'value')
    ) {
      configurations[snapshot.key] = snapshot.value;
    }
  }
  return { clientId, configurations };
}

export const clientConfigurationService = {
  createClientConfiguration,
  getClientConfigurationById,
  getEffectiveClientConfiguration,
  listClientConfigurations,
  resolveClientConfigurationContext,
  toPublicClientConfiguration,
  updateClientConfiguration,
};
