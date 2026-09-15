import { clientInactiveError } from '../clients';
import {
  resolveClientConfigurationContext,
} from '../client-configurations';
import {
  resolveBuildingConfigurationContext,
} from '../building-configurations';
import { contextAccessService } from '../context-access';
import {
  captureConfigurationVersion,
  resolveLifecycleEffectiveSnapshot,
} from '../configuration-versions';
import { entitlementService } from '../entitlements';
import {
  moduleInactiveError,
  moduleNotFoundError,
  moduleRepository,
} from '../modules';
import { subscriptionRepository } from '../subscriptions';
import {
  moduleConfigurationAlreadyExistsError,
  moduleConfigurationNotFoundError,
} from './module-configuration.errors';
import { moduleConfigurationRepository } from './module-configuration.repository';
import type {
  CreateModuleConfigurationInput,
  EffectiveModuleConfiguration,
  EffectiveModuleConfigurationItem,
  ModuleConfigurationRecord,
  ModuleConfigurationScope,
  NewModuleConfiguration,
  PublicModuleConfiguration,
  UpdateModuleConfigurationInput,
} from './module-configuration.types';

export function toPublicModuleConfiguration(
  record: ModuleConfigurationRecord,
): PublicModuleConfiguration {
  return {
    id: record.id,
    scopeType: record.scopeType,
    clientId: record.clientId,
    buildingId: record.buildingId,
    moduleId: record.moduleId,
    moduleKey: record.moduleKey,
    moduleName: record.moduleName,
    enabled: record.enabled,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function versionModuleConfiguration(
  configuration: PublicModuleConfiguration,
  userId: string,
): Promise<PublicModuleConfiguration> {
  await captureConfigurationVersion(
    {
      sourceType: 'MODULE_CONFIGURATION',
      sourceConfigurationId: configuration.id,
      clientId: configuration.clientId,
      buildingId: configuration.buildingId,
      status: configuration.enabled ? 'ENABLED' : 'DISABLED',
      snapshot: configuration,
    },
    userId,
  );
  return configuration;
}

async function requireActiveModule(moduleKey: string) {
  const module = await moduleRepository.findByCode(moduleKey);
  if (!module) throw moduleNotFoundError();
  if (module.status !== 'ACTIVE') throw moduleInactiveError();
  return module;
}

function isScopeUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error) || (error as { code?: string }).code !== '23505') {
    return false;
  }
  const constraint = (error as { constraint?: string }).constraint;
  return (
    constraint === 'module_configurations_client_module_unique' ||
    constraint === 'module_configurations_building_module_unique'
  );
}

async function createForScope(
  scopeType: ModuleConfigurationScope,
  scopeId: string,
  input: CreateModuleConfigurationInput,
): Promise<PublicModuleConfiguration> {
  const module = await requireActiveModule(input.moduleKey);
  if (
    await moduleConfigurationRepository.findByScopeAndModule(
      scopeType,
      scopeId,
      module.id,
    )
  ) {
    throw moduleConfigurationAlreadyExistsError();
  }

  const next: NewModuleConfiguration = {
    scopeType,
    clientId: scopeType === 'CLIENT' ? scopeId : null,
    buildingId: scopeType === 'BUILDING' ? scopeId : null,
    moduleId: module.id,
    enabled: input.enabled,
  };
  try {
    return toPublicModuleConfiguration(
      await moduleConfigurationRepository.create(next),
    );
  } catch (error) {
    if (isScopeUniqueViolation(error)) {
      throw moduleConfigurationAlreadyExistsError();
    }
    throw error;
  }
}

export async function createClientModuleConfiguration(
  clientId: string,
  input: CreateModuleConfigurationInput,
  userId: string,
): Promise<PublicModuleConfiguration> {
  const client = await resolveClientConfigurationContext(clientId, userId);
  if (client.status !== 'ACTIVE') throw clientInactiveError();
  return versionModuleConfiguration(
    await createForScope('CLIENT', client.id, input),
    userId,
  );
}

export async function createBuildingModuleConfiguration(
  buildingId: string,
  input: CreateModuleConfigurationInput,
  userId: string,
): Promise<PublicModuleConfiguration> {
  const context = await resolveBuildingConfigurationContext(buildingId, userId);
  if (context.clientStatus !== 'ACTIVE') throw clientInactiveError();
  return versionModuleConfiguration(
    await createForScope('BUILDING', context.buildingId, input),
    userId,
  );
}

export async function listClientModuleConfigurations(
  clientId: string,
  userId: string,
): Promise<PublicModuleConfiguration[]> {
  await resolveClientConfigurationContext(clientId, userId);
  return (await moduleConfigurationRepository.listByScope('CLIENT', clientId)).map(
    toPublicModuleConfiguration,
  );
}

export async function listBuildingModuleConfigurations(
  buildingId: string,
  userId: string,
): Promise<PublicModuleConfiguration[]> {
  await resolveBuildingConfigurationContext(buildingId, userId);
  return (
    await moduleConfigurationRepository.listByScope('BUILDING', buildingId)
  ).map(toPublicModuleConfiguration);
}

async function requireScopedRecord(
  id: string,
  userId: string,
): Promise<ModuleConfigurationRecord> {
  const record = await moduleConfigurationRepository.findById(id);
  if (!record) throw moduleConfigurationNotFoundError();
  if (record.scopeType === 'BUILDING' && record.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  } else {
    await resolveClientConfigurationContext(record.clientId, userId);
  }
  return record;
}

export async function getModuleConfigurationById(
  id: string,
  userId: string,
): Promise<PublicModuleConfiguration> {
  return toPublicModuleConfiguration(await requireScopedRecord(id, userId));
}

export async function updateModuleConfiguration(
  id: string,
  input: UpdateModuleConfigurationInput,
  userId: string,
): Promise<PublicModuleConfiguration> {
  await requireScopedRecord(id, userId);
  const updated = await moduleConfigurationRepository.updateEnabled(
    id,
    input.enabled,
  );
  if (!updated) throw moduleConfigurationNotFoundError();
  return versionModuleConfiguration(
    toPublicModuleConfiguration(updated),
    userId,
  );
}

/**
 * Resolves commercial availability by composing the existing per-Subscription
 * entitlement resolver. No Subscription/License/Entitlement validity rule is
 * repeated here.
 */
async function resolveEntitledModuleIds(clientId: string): Promise<Set<string>> {
  const subscriptions = await subscriptionRepository.findByClientId(clientId);
  const entitled = new Set<string>();
  const now = new Date();
  for (const subscription of subscriptions) {
    const modules = await entitlementService.resolveEffectiveEntitlements(
      subscription.id,
      now,
    );
    for (const module of modules) entitled.add(module.moduleId);
  }
  return entitled;
}

async function projectEffective(
  clientId: string,
  buildingId: string | null,
  records: ModuleConfigurationRecord[],
): Promise<EffectiveModuleConfiguration> {
  const entitledModuleIds = await resolveEntitledModuleIds(clientId);
  const modules: EffectiveModuleConfigurationItem[] = [];
  for (const record of records) {
    const snapshot = await resolveLifecycleEffectiveSnapshot(
      'MODULE_CONFIGURATION',
      record.id,
      toPublicModuleConfiguration(record),
    );
    if (
      typeof snapshot !== 'object' ||
      snapshot === null ||
      Array.isArray(snapshot) ||
      typeof snapshot.enabled !== 'boolean'
    ) {
      continue;
    }
    const entitled = entitledModuleIds.has(record.moduleId);
    modules.push({
      moduleId: record.moduleId,
      moduleKey: record.moduleKey,
      moduleName: record.moduleName,
      configuredEnabled: snapshot.enabled,
      entitled,
      enabled: snapshot.enabled && entitled,
      source: record.scopeType,
    });
  }
  modules.sort((left, right) => left.moduleKey.localeCompare(right.moduleKey));
  return { clientId, buildingId, modules };
}

export async function getEffectiveClientModuleConfiguration(
  clientId: string,
  userId: string,
): Promise<EffectiveModuleConfiguration> {
  const client = await resolveClientConfigurationContext(clientId, userId);
  if (client.status !== 'ACTIVE') throw clientInactiveError();
  const records = await moduleConfigurationRepository.listByScope(
    'CLIENT',
    client.id,
  );
  return projectEffective(client.id, null, records);
}

export async function getEffectiveBuildingModuleConfiguration(
  buildingId: string,
  userId: string,
): Promise<EffectiveModuleConfiguration> {
  const context = await resolveBuildingConfigurationContext(buildingId, userId);
  if (context.clientStatus !== 'ACTIVE') throw clientInactiveError();

  const [clientRecords, buildingRecords] = await Promise.all([
    moduleConfigurationRepository.listByScope('CLIENT', context.clientId),
    moduleConfigurationRepository.listByScope('BUILDING', context.buildingId),
  ]);
  const byModule = new Map<string, ModuleConfigurationRecord>();
  for (const record of clientRecords) byModule.set(record.moduleId, record);
  for (const record of buildingRecords) byModule.set(record.moduleId, record);
  return projectEffective(
    context.clientId,
    context.buildingId,
    [...byModule.values()],
  );
}

export const moduleConfigurationService = {
  createBuildingModuleConfiguration,
  createClientModuleConfiguration,
  getEffectiveBuildingModuleConfiguration,
  getEffectiveClientModuleConfiguration,
  getModuleConfigurationById,
  listBuildingModuleConfigurations,
  listClientModuleConfigurations,
  toPublicModuleConfiguration,
  updateModuleConfiguration,
};
