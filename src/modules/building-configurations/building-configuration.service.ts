import {
  buildingNotFoundError,
  buildingRepository,
} from '../buildings';
import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import { clientConfigurationService } from '../client-configurations';
import { contextAccessService } from '../context-access';
import {
  captureConfigurationVersion,
  resolveLifecycleEffectiveSnapshot,
} from '../configuration-versions';
import { propertyNotFoundError, propertyRepository } from '../properties';
import {
  buildingConfigurationKeyAlreadyExistsError,
  buildingConfigurationNotFoundError,
} from './building-configuration.errors';
import { buildingConfigurationRepository } from './building-configuration.repository';
import type {
  BuildingConfigurationFilters,
  BuildingConfigurationRecord,
  BuildingConfigurationValue,
  CreateBuildingConfigurationInput,
  EffectiveBuildingConfiguration,
  NewBuildingConfiguration,
  PublicBuildingConfiguration,
  UpdateBuildingConfigurationInput,
} from './building-configuration.types';

export type BuildingConfigurationContext = {
  buildingId: string;
  clientId: string;
  clientStatus: string;
};

function isReservedConfigurationKey(key: string): boolean {
  return (
    key.startsWith('OPERATIONAL.') ||
    key.startsWith('PRESENTATION.') ||
    key.startsWith('BRANDING.')
  );
}

/**
 * Resolves Building → Property → Client using existing masters after the
 * BE-02G Building assignment check. No Client ownership is stored separately
 * in Building configuration.
 */
export async function resolveBuildingConfigurationContext(
  buildingId: string,
  userId: string,
): Promise<BuildingConfigurationContext> {
  await contextAccessService.assertBuildingAccess(userId, buildingId);
  return resolveBuildingIdentityContext(buildingId);
}

/**
 * Access-neutral Building → Property → Client identity resolution (the
 * exact identity half of {@link resolveBuildingConfigurationContext},
 * factored out unchanged for CR-HM-BE-06 Run 2 §11). This performs NO
 * access decision and no business rule beyond existence identity: callers
 * MUST be independently preauthorized for the Building (e.g. the governed
 * Handyman Work Session field-lead chain, which proves visit-scoped
 * authority stronger than a building assignment).
 */
export async function resolveBuildingIdentityContext(
  buildingId: string,
): Promise<BuildingConfigurationContext> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) throw buildingNotFoundError();
  const property = await propertyRepository.findById(building.propertyId);
  if (!property) throw propertyNotFoundError();
  const client = await clientRepository.findById(property.clientId);
  if (!client) throw clientNotFoundError();
  return {
    buildingId: building.id,
    clientId: client.id,
    clientStatus: client.status,
  };
}

export function toPublicBuildingConfiguration(
  record: BuildingConfigurationRecord,
): PublicBuildingConfiguration {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    key: record.key,
    value: record.value,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function versionBuildingConfiguration(
  configuration: PublicBuildingConfiguration,
  userId: string,
): Promise<PublicBuildingConfiguration> {
  await captureConfigurationVersion(
    {
      sourceType: 'BUILDING_CONFIGURATION',
      sourceConfigurationId: configuration.id,
      clientId: configuration.clientId,
      buildingId: configuration.buildingId,
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
      'building_configurations_building_key_unique'
  );
}

export async function createBuildingConfiguration(
  input: CreateBuildingConfigurationInput,
  userId: string,
): Promise<PublicBuildingConfiguration> {
  const context = await resolveBuildingConfigurationContext(input.buildingId, userId);
  if (context.clientStatus !== 'ACTIVE') throw clientInactiveError();

  const existing = await buildingConfigurationRepository.findByBuildingAndKey(
    context.buildingId,
    input.key,
  );
  if (existing) throw buildingConfigurationKeyAlreadyExistsError();

  const next: NewBuildingConfiguration = {
    buildingId: context.buildingId,
    key: input.key,
    value: input.value,
    status: input.status ?? 'ACTIVE',
  };
  try {
    return versionBuildingConfiguration(
      toPublicBuildingConfiguration(
        await buildingConfigurationRepository.create(next),
      ),
      userId,
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw buildingConfigurationKeyAlreadyExistsError();
    }
    throw error;
  }
}

export async function listBuildingConfigurations(
  buildingId: string,
  filters: BuildingConfigurationFilters,
  userId: string,
  includeReserved = false,
): Promise<PublicBuildingConfiguration[]> {
  await resolveBuildingConfigurationContext(buildingId, userId);
  return (
    await buildingConfigurationRepository.listByBuilding(buildingId, filters)
  )
    .filter(
      (record) =>
        includeReserved || !isReservedConfigurationKey(record.key),
    )
    .map(toPublicBuildingConfiguration);
}

export async function getBuildingConfigurationById(
  id: string,
  userId: string,
  includeReserved = false,
): Promise<PublicBuildingConfiguration> {
  const record = await buildingConfigurationRepository.findById(id);
  if (
    !record ||
    (!includeReserved && isReservedConfigurationKey(record.key))
  ) {
    throw buildingConfigurationNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicBuildingConfiguration(record);
}

export async function updateBuildingConfiguration(
  id: string,
  input: UpdateBuildingConfigurationInput,
  userId: string,
  includeReserved = false,
): Promise<PublicBuildingConfiguration> {
  const current = await buildingConfigurationRepository.findById(id);
  if (
    !current ||
    (!includeReserved && isReservedConfigurationKey(current.key))
  ) {
    throw buildingConfigurationNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, current.buildingId);
  const updated = await buildingConfigurationRepository.update(id, input);
  if (!updated) throw buildingConfigurationNotFoundError();
  return versionBuildingConfiguration(
    toPublicBuildingConfiguration(updated),
    userId,
  );
}

/**
 * Reuses BE-27A's effective Client resolver, then overlays ACTIVE records for
 * the selected Building. Building values win by key; an INACTIVE Building
 * record does not suppress its Client fallback.
 */
export async function getEffectiveBuildingConfiguration(
  buildingId: string,
  userId: string,
  includeReserved = false,
): Promise<EffectiveBuildingConfiguration> {
  const context = await resolveBuildingConfigurationContext(buildingId, userId);
  const clientEffective =
    await clientConfigurationService.getEffectiveClientConfiguration(
      context.clientId,
      userId,
      includeReserved,
    );
  const buildingRecords =
    await buildingConfigurationRepository.listByBuilding(buildingId);
  const configurations: Record<string, BuildingConfigurationValue> = {
    ...clientEffective.configurations,
  };
  for (const record of buildingRecords) {
    if (!includeReserved && isReservedConfigurationKey(record.key)) continue;
    const current = toPublicBuildingConfiguration(record);
    const snapshot = await resolveLifecycleEffectiveSnapshot(
      'BUILDING_CONFIGURATION',
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
  return { clientId: context.clientId, buildingId, configurations };
}

export const buildingConfigurationService = {
  createBuildingConfiguration,
  getBuildingConfigurationById,
  getEffectiveBuildingConfiguration,
  listBuildingConfigurations,
  resolveBuildingConfigurationContext,
  toPublicBuildingConfiguration,
  updateBuildingConfiguration,
};
