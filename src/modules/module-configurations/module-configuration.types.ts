export const MODULE_CONFIGURATION_SCOPES = ['CLIENT', 'BUILDING'] as const;
export type ModuleConfigurationScope =
  (typeof MODULE_CONFIGURATION_SCOPES)[number];

/** Persisted configuration joined to the existing Module catalogue/context. */
export type ModuleConfigurationRecord = {
  id: string;
  scopeType: ModuleConfigurationScope;
  clientId: string;
  buildingId: string | null;
  moduleId: string;
  moduleKey: string;
  moduleName: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicModuleConfiguration = Omit<
  ModuleConfigurationRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

export type CreateModuleConfigurationInput = {
  moduleKey: string;
  enabled: boolean;
};

export type UpdateModuleConfigurationInput = {
  enabled: boolean;
};

export type NewModuleConfiguration = {
  scopeType: ModuleConfigurationScope;
  clientId: string | null;
  buildingId: string | null;
  moduleId: string;
  enabled: boolean;
};

export const MODULE_CONFIGURATION_SOURCES = ['CLIENT', 'BUILDING'] as const;
export type ModuleConfigurationSource =
  (typeof MODULE_CONFIGURATION_SOURCES)[number];

/** Backend-authoritative result after configuration ∩ commercial entitlement. */
export type EffectiveModuleConfigurationItem = {
  moduleId: string;
  moduleKey: string;
  moduleName: string;
  configuredEnabled: boolean;
  entitled: boolean;
  enabled: boolean;
  source: ModuleConfigurationSource;
};

export type EffectiveModuleConfiguration = {
  clientId: string;
  buildingId: string | null;
  modules: EffectiveModuleConfigurationItem[];
};
