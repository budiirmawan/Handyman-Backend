import { AppError } from '../../shared/errors';
import {
  buildingConfigurationService,
  type PublicBuildingConfiguration,
} from '../building-configurations';
import {
  clientConfigurationService,
  type ClientConfigurationValue,
  type PublicClientConfiguration,
} from '../client-configurations';
import {
  operationalSettingNotFoundError,
  operationalSettingScopeNotAllowedError,
} from './operational-setting.errors';
import {
  OPERATIONAL_SETTING_DEFINITIONS,
  type CreateOperationalSettingInput,
  type EffectiveOperationalSetting,
  type EffectiveOperationalSettings,
  type OperationalSettingEnvelope,
  type OperationalSettingFilters,
  type OperationalSettingKey,
  type OperationalSettingScope,
  type PublicOperationalSetting,
  type UpdateOperationalSettingInput,
} from './operational-setting.types';
import { validateOperationalSettingValue } from './operational-setting.validation';

const PREFIX = 'OPERATIONAL.';

function isRecord(value: unknown): value is Record<string, ClientConfigurationValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function internalKey(key: OperationalSettingKey): string {
  return `${PREFIX}${key}`;
}

function settingKey(key: string): OperationalSettingKey | null {
  if (!key.startsWith(PREFIX)) return null;
  const publicKey = key.slice(PREFIX.length);
  return (
    OPERATIONAL_SETTING_DEFINITIONS.find(
      (definition) => definition.key === publicKey,
    )?.key ?? null
  );
}

function assertScope(key: OperationalSettingKey, scope: OperationalSettingScope): void {
  const definition = OPERATIONAL_SETTING_DEFINITIONS.find(
    (candidate) => candidate.key === key,
  );
  if (
    !definition ||
    !(definition.scopes as readonly OperationalSettingScope[]).includes(scope)
  ) {
    throw operationalSettingScopeNotAllowedError();
  }
}

function envelope(value: ClientConfigurationValue): OperationalSettingEnvelope {
  if (
    !isRecord(value) ||
    typeof value.enabled !== 'boolean' ||
    !Object.prototype.hasOwnProperty.call(value, 'settingValue')
  ) {
    throw AppError.internal('Operational Setting data is invalid.');
  }
  return {
    enabled: value.enabled,
    settingValue: value.settingValue,
  };
}

function clientPublic(record: PublicClientConfiguration): PublicOperationalSetting {
  const key = settingKey(record.key);
  if (!key) throw operationalSettingNotFoundError();
  assertScope(key, 'CLIENT');
  const stored = envelope(record.value);
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: null,
    scopeType: 'CLIENT',
    key,
    value: validateOperationalSettingValue(key, stored.settingValue),
    enabled: stored.enabled,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function buildingPublic(
  record: PublicBuildingConfiguration,
): PublicOperationalSetting {
  const key = settingKey(record.key);
  if (!key) throw operationalSettingNotFoundError();
  assertScope(key, 'BUILDING');
  const stored = envelope(record.value);
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    scopeType: 'BUILDING',
    key,
    value: validateOperationalSettingValue(key, stored.settingValue),
    enabled: stored.enabled,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function storedValue(
  value: ClientConfigurationValue,
  enabled: boolean,
): OperationalSettingEnvelope {
  return { enabled, settingValue: value };
}

export async function createClientOperationalSetting(
  clientId: string,
  input: CreateOperationalSettingInput,
  userId: string,
): Promise<PublicOperationalSetting> {
  assertScope(input.key, 'CLIENT');
  const value = validateOperationalSettingValue(input.key, input.value);
  return clientPublic(
    await clientConfigurationService.createClientConfiguration(
      {
        clientId,
        key: internalKey(input.key),
        value: storedValue(value, input.enabled),
        status: input.status,
      },
      userId,
    ),
  );
}

export async function createBuildingOperationalSetting(
  buildingId: string,
  input: CreateOperationalSettingInput,
  userId: string,
): Promise<PublicOperationalSetting> {
  assertScope(input.key, 'BUILDING');
  const value = validateOperationalSettingValue(input.key, input.value);
  return buildingPublic(
    await buildingConfigurationService.createBuildingConfiguration(
      {
        buildingId,
        key: internalKey(input.key),
        value: storedValue(value, input.enabled),
        status: input.status,
      },
      userId,
    ),
  );
}

export async function listClientOperationalSettings(
  clientId: string,
  filters: OperationalSettingFilters,
  userId: string,
): Promise<PublicOperationalSetting[]> {
  const records = await clientConfigurationService.listClientConfigurations(
    clientId,
    filters,
    userId,
    true,
  );
  return records
    .filter((record) => settingKey(record.key) !== null)
    .map(clientPublic);
}

export async function listBuildingOperationalSettings(
  buildingId: string,
  filters: OperationalSettingFilters,
  userId: string,
): Promise<PublicOperationalSetting[]> {
  const records = await buildingConfigurationService.listBuildingConfigurations(
    buildingId,
    filters,
    userId,
    true,
  );
  return records
    .filter((record) => settingKey(record.key) !== null)
    .map(buildingPublic);
}

export async function getClientOperationalSetting(
  id: string,
  userId: string,
): Promise<PublicOperationalSetting> {
  return clientPublic(
    await clientConfigurationService.getClientConfigurationById(id, userId, true),
  );
}

export async function getBuildingOperationalSetting(
  id: string,
  userId: string,
): Promise<PublicOperationalSetting> {
  return buildingPublic(
    await buildingConfigurationService.getBuildingConfigurationById(
      id,
      userId,
      true,
    ),
  );
}

export async function updateClientOperationalSetting(
  id: string,
  input: UpdateOperationalSettingInput,
  userId: string,
): Promise<PublicOperationalSetting> {
  const current = await getClientOperationalSetting(id, userId);
  const value =
    input.value === undefined
      ? current.value
      : validateOperationalSettingValue(current.key, input.value);
  const enabled = input.enabled ?? current.enabled;
  return clientPublic(
    await clientConfigurationService.updateClientConfiguration(
      id,
      {
        ...(input.value !== undefined || input.enabled !== undefined
          ? { value: storedValue(value, enabled) }
          : {}),
        ...(input.status === undefined ? {} : { status: input.status }),
      },
      userId,
      true,
    ),
  );
}

export async function updateBuildingOperationalSetting(
  id: string,
  input: UpdateOperationalSettingInput,
  userId: string,
): Promise<PublicOperationalSetting> {
  const current = await getBuildingOperationalSetting(id, userId);
  const value =
    input.value === undefined
      ? current.value
      : validateOperationalSettingValue(current.key, input.value);
  const enabled = input.enabled ?? current.enabled;
  return buildingPublic(
    await buildingConfigurationService.updateBuildingConfiguration(
      id,
      {
        ...(input.value !== undefined || input.enabled !== undefined
          ? { value: storedValue(value, enabled) }
          : {}),
        ...(input.status === undefined ? {} : { status: input.status }),
      },
      userId,
      true,
    ),
  );
}

function effectiveSettings(
  configurations: Record<string, ClientConfigurationValue>,
): EffectiveOperationalSetting[] {
  const settings: EffectiveOperationalSetting[] = [];
  for (const [storedKey, rawValue] of Object.entries(configurations)) {
    const key = settingKey(storedKey);
    if (!key) continue;
    const stored = envelope(rawValue);
    settings.push({
      key,
      value: validateOperationalSettingValue(key, stored.settingValue),
      enabled: stored.enabled,
      status: 'ACTIVE',
    });
  }
  return settings.sort((left, right) => left.key.localeCompare(right.key));
}

export async function getEffectiveClientOperationalSettings(
  clientId: string,
  userId: string,
): Promise<EffectiveOperationalSettings> {
  const effective =
    await clientConfigurationService.getEffectiveClientConfiguration(
      clientId,
      userId,
      true,
    );
  return {
    clientId: effective.clientId,
    buildingId: null,
    settings: effectiveSettings(effective.configurations),
  };
}

export async function getEffectiveBuildingOperationalSettings(
  buildingId: string,
  userId: string,
): Promise<EffectiveOperationalSettings> {
  const effective =
    await buildingConfigurationService.getEffectiveBuildingConfiguration(
      buildingId,
      userId,
      true,
    );
  return {
    clientId: effective.clientId,
    buildingId: effective.buildingId,
    settings: effectiveSettings(effective.configurations),
  };
}

export const operationalSettingService = {
  createBuildingOperationalSetting,
  createClientOperationalSetting,
  getBuildingOperationalSetting,
  getClientOperationalSetting,
  getEffectiveBuildingOperationalSettings,
  getEffectiveClientOperationalSettings,
  listBuildingOperationalSettings,
  listClientOperationalSettings,
  updateBuildingOperationalSetting,
  updateClientOperationalSetting,
};
