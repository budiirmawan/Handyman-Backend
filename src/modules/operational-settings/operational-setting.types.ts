import type {
  ClientConfigurationStatus,
  ClientConfigurationValue,
} from '../client-configurations';

export const OPERATIONAL_SETTING_SCOPES = ['CLIENT', 'BUILDING'] as const;
export type OperationalSettingScope =
  (typeof OPERATIONAL_SETTING_SCOPES)[number];

/**
 * BE-27J allowlist. These values are defaults/configuration metadata only:
 * owning domain APIs continue to validate every operational write.
 */
export const OPERATIONAL_SETTING_DEFINITIONS = [
  {
    key: 'SCHEDULE.DEFAULT_TIMEZONE',
    valueType: 'IANA_TIMEZONE',
    scopes: ['CLIENT', 'BUILDING'],
    description:
      'Default timezone metadata for schedule administration. Schedule timezone validation remains authoritative.',
  },
] as const;

export type OperationalSettingKey =
  (typeof OPERATIONAL_SETTING_DEFINITIONS)[number]['key'];
export type OperationalSettingStatus = ClientConfigurationStatus;
export type OperationalSettingValue = ClientConfigurationValue;

export type OperationalSettingEnvelope = {
  enabled: boolean;
  settingValue: OperationalSettingValue;
};

export type PublicOperationalSetting = {
  id: string;
  clientId: string;
  buildingId: string | null;
  scopeType: OperationalSettingScope;
  key: OperationalSettingKey;
  value: OperationalSettingValue;
  enabled: boolean;
  status: OperationalSettingStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateOperationalSettingInput = {
  key: OperationalSettingKey;
  value: OperationalSettingValue;
  enabled: boolean;
  status: OperationalSettingStatus;
};

export type UpdateOperationalSettingInput = {
  value?: OperationalSettingValue;
  enabled?: boolean;
  status?: OperationalSettingStatus;
};

export type OperationalSettingFilters = {
  status?: OperationalSettingStatus;
};

export type EffectiveOperationalSetting = {
  key: OperationalSettingKey;
  value: OperationalSettingValue;
  enabled: boolean;
  status: 'ACTIVE';
};

export type EffectiveOperationalSettings = {
  clientId: string;
  buildingId: string | null;
  settings: EffectiveOperationalSetting[];
};
