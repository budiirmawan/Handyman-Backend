import { resolveBuildingConfigurationContext } from '../building-configurations';
import { clientInactiveError } from '../clients';
import { resolveClientConfigurationContext } from '../client-configurations';
import { contextAccessService } from '../context-access';
import {
  captureConfigurationVersion,
  resolveLifecycleEffectiveSnapshot,
} from '../configuration-versions';
import {
  moduleConfigurationService,
  type EffectiveModuleConfiguration,
  type ModuleConfigurationScope,
} from '../module-configurations';
import {
  moduleInactiveError,
  moduleNotFoundError,
  moduleRepository,
} from '../modules';
import {
  featureEntitlementConfigurationAlreadyExistsError,
  featureEntitlementConfigurationNotFoundError,
} from './feature-entitlement-configuration.errors';
import { featureEntitlementConfigurationRepository } from './feature-entitlement-configuration.repository';
import type {
  CreateFeatureEntitlementConfigurationInput,
  EffectiveFeatureEntitlementConfiguration,
  EffectiveFeatureEntitlementItem,
  FeatureEntitlementConfigurationRecord,
  FeatureEntitlementState,
  NewFeatureEntitlementConfiguration,
  PublicFeatureEntitlementConfiguration,
  UpdateFeatureEntitlementConfigurationInput,
} from './feature-entitlement-configuration.types';

export function toPublicFeatureEntitlementConfiguration(
  record: FeatureEntitlementConfigurationRecord,
): PublicFeatureEntitlementConfiguration {
  return {
    id: record.id,
    scopeType: record.scopeType,
    clientId: record.clientId,
    buildingId: record.buildingId,
    moduleId: record.moduleId,
    moduleKey: record.moduleKey,
    moduleName: record.moduleName,
    featureKey: record.featureKey,
    state: record.state,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function versionFeatureConfiguration(
  configuration: PublicFeatureEntitlementConfiguration,
  userId: string,
): Promise<PublicFeatureEntitlementConfiguration> {
  await captureConfigurationVersion(
    {
      sourceType: 'FEATURE_ENTITLEMENT_CONFIGURATION',
      sourceConfigurationId: configuration.id,
      clientId: configuration.clientId,
      buildingId: configuration.buildingId,
      status: configuration.state,
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

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error) || (error as { code?: string }).code !== '23505') {
    return false;
  }
  const constraint = (error as { constraint?: string }).constraint;
  return (
    constraint === 'feature_entitlement_configurations_client_unique' ||
    constraint === 'feature_entitlement_configurations_building_unique'
  );
}

async function createForScope(
  scopeType: ModuleConfigurationScope,
  scopeId: string,
  input: CreateFeatureEntitlementConfigurationInput,
): Promise<PublicFeatureEntitlementConfiguration> {
  const module = await requireActiveModule(input.moduleKey);
  if (
    await featureEntitlementConfigurationRepository.findByScopeModuleFeature(
      scopeType,
      scopeId,
      module.id,
      input.featureKey,
    )
  ) {
    throw featureEntitlementConfigurationAlreadyExistsError();
  }
  const next: NewFeatureEntitlementConfiguration = {
    scopeType,
    clientId: scopeType === 'CLIENT' ? scopeId : null,
    buildingId: scopeType === 'BUILDING' ? scopeId : null,
    moduleId: module.id,
    featureKey: input.featureKey,
    state: input.state,
  };
  try {
    return toPublicFeatureEntitlementConfiguration(
      await featureEntitlementConfigurationRepository.create(next),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw featureEntitlementConfigurationAlreadyExistsError();
    }
    throw error;
  }
}

export async function createClientFeatureEntitlementConfiguration(
  clientId: string,
  input: CreateFeatureEntitlementConfigurationInput,
  userId: string,
): Promise<PublicFeatureEntitlementConfiguration> {
  const client = await resolveClientConfigurationContext(clientId, userId);
  if (client.status !== 'ACTIVE') throw clientInactiveError();
  return versionFeatureConfiguration(
    await createForScope('CLIENT', client.id, input),
    userId,
  );
}

export async function createBuildingFeatureEntitlementConfiguration(
  buildingId: string,
  input: CreateFeatureEntitlementConfigurationInput,
  userId: string,
): Promise<PublicFeatureEntitlementConfiguration> {
  const context = await resolveBuildingConfigurationContext(buildingId, userId);
  if (context.clientStatus !== 'ACTIVE') throw clientInactiveError();
  return versionFeatureConfiguration(
    await createForScope('BUILDING', context.buildingId, input),
    userId,
  );
}

export async function listClientFeatureEntitlementConfigurations(
  clientId: string,
  userId: string,
): Promise<PublicFeatureEntitlementConfiguration[]> {
  await resolveClientConfigurationContext(clientId, userId);
  return (
    await featureEntitlementConfigurationRepository.listByScope('CLIENT', clientId)
  ).map(toPublicFeatureEntitlementConfiguration);
}

export async function listBuildingFeatureEntitlementConfigurations(
  buildingId: string,
  userId: string,
): Promise<PublicFeatureEntitlementConfiguration[]> {
  await resolveBuildingConfigurationContext(buildingId, userId);
  return (
    await featureEntitlementConfigurationRepository.listByScope(
      'BUILDING',
      buildingId,
    )
  ).map(toPublicFeatureEntitlementConfiguration);
}

async function requireScopedRecord(
  id: string,
  userId: string,
): Promise<FeatureEntitlementConfigurationRecord> {
  const record = await featureEntitlementConfigurationRepository.findById(id);
  if (!record) throw featureEntitlementConfigurationNotFoundError();
  if (record.scopeType === 'BUILDING' && record.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  } else {
    await resolveClientConfigurationContext(record.clientId, userId);
  }
  return record;
}

export async function getFeatureEntitlementConfigurationById(
  id: string,
  userId: string,
): Promise<PublicFeatureEntitlementConfiguration> {
  return toPublicFeatureEntitlementConfiguration(
    await requireScopedRecord(id, userId),
  );
}

export async function updateFeatureEntitlementConfiguration(
  id: string,
  input: UpdateFeatureEntitlementConfigurationInput,
  userId: string,
): Promise<PublicFeatureEntitlementConfiguration> {
  await requireScopedRecord(id, userId);
  const updated = await featureEntitlementConfigurationRepository.updateState(
    id,
    input.state,
  );
  if (!updated) throw featureEntitlementConfigurationNotFoundError();
  return versionFeatureConfiguration(
    toPublicFeatureEntitlementConfiguration(updated),
    userId,
  );
}

async function projectEffective(
  moduleEffective: EffectiveModuleConfiguration,
  features: FeatureEntitlementConfigurationRecord[],
): Promise<EffectiveFeatureEntitlementConfiguration> {
  const moduleById = new Map(
    moduleEffective.modules.map((module) => [module.moduleId, module]),
  );
  const projected: EffectiveFeatureEntitlementItem[] = [];
  for (const feature of features) {
    const snapshot = await resolveLifecycleEffectiveSnapshot(
      'FEATURE_ENTITLEMENT_CONFIGURATION',
      feature.id,
      toPublicFeatureEntitlementConfiguration(feature),
    );
    if (
      typeof snapshot !== 'object' ||
      snapshot === null ||
      Array.isArray(snapshot) ||
      (snapshot.state !== 'ENABLED' && snapshot.state !== 'DISABLED')
    ) {
      continue;
    }
    const moduleEnabled = moduleById.get(feature.moduleId)?.enabled ?? false;
    const enabled = snapshot.state === 'ENABLED' && moduleEnabled;
    projected.push({
      moduleId: feature.moduleId,
      moduleKey: feature.moduleKey,
      moduleName: feature.moduleName,
      featureKey: feature.featureKey,
      configuredState: snapshot.state as FeatureEntitlementState,
      moduleEnabled,
      state: enabled ? ('ENABLED' as const) : ('DISABLED' as const),
      source: feature.scopeType,
    });
  }
  projected.sort((left, right) =>
    `${left.moduleKey}.${left.featureKey}`.localeCompare(
      `${right.moduleKey}.${right.featureKey}`,
    ),
  );
  return {
    clientId: moduleEffective.clientId,
    buildingId: moduleEffective.buildingId,
    features: projected,
  };
}

export async function getEffectiveClientFeatureEntitlements(
  clientId: string,
  userId: string,
): Promise<EffectiveFeatureEntitlementConfiguration> {
  const client = await resolveClientConfigurationContext(clientId, userId);
  if (client.status !== 'ACTIVE') throw clientInactiveError();
  const [moduleEffective, features] = await Promise.all([
    moduleConfigurationService.getEffectiveClientModuleConfiguration(
      client.id,
      userId,
    ),
    featureEntitlementConfigurationRepository.listByScope('CLIENT', client.id),
  ]);
  return projectEffective(moduleEffective, features);
}

export async function getEffectiveBuildingFeatureEntitlements(
  buildingId: string,
  userId: string,
): Promise<EffectiveFeatureEntitlementConfiguration> {
  const context = await resolveBuildingConfigurationContext(buildingId, userId);
  if (context.clientStatus !== 'ACTIVE') throw clientInactiveError();
  const [moduleEffective, clientFeatures, buildingFeatures] = await Promise.all([
    moduleConfigurationService.getEffectiveBuildingModuleConfiguration(
      context.buildingId,
      userId,
    ),
    featureEntitlementConfigurationRepository.listByScope(
      'CLIENT',
      context.clientId,
    ),
    featureEntitlementConfigurationRepository.listByScope(
      'BUILDING',
      context.buildingId,
    ),
  ]);
  const byFeature = new Map<string, FeatureEntitlementConfigurationRecord>();
  for (const feature of clientFeatures) {
    byFeature.set(`${feature.moduleId}:${feature.featureKey}`, feature);
  }
  for (const feature of buildingFeatures) {
    byFeature.set(`${feature.moduleId}:${feature.featureKey}`, feature);
  }
  return projectEffective(moduleEffective, [...byFeature.values()]);
}

export const featureEntitlementConfigurationService = {
  createBuildingFeatureEntitlementConfiguration,
  createClientFeatureEntitlementConfiguration,
  getEffectiveBuildingFeatureEntitlements,
  getEffectiveClientFeatureEntitlements,
  getFeatureEntitlementConfigurationById,
  listBuildingFeatureEntitlementConfigurations,
  listClientFeatureEntitlementConfigurations,
  toPublicFeatureEntitlementConfiguration,
  updateFeatureEntitlementConfiguration,
};
