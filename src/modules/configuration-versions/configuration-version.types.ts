export const CONFIGURATION_VERSION_SOURCE_TYPES = [
  'CLIENT_CONFIGURATION',
  'BUILDING_CONFIGURATION',
  'MODULE_CONFIGURATION',
  'FEATURE_ENTITLEMENT_CONFIGURATION',
  'NAVIGATION_ITEM',
  'WORKSPACE',
  'DASHBOARD',
  'DASHBOARD_WIDGET',
  'CMS_CONTENT',
] as const;
export type ConfigurationVersionSourceType =
  (typeof CONFIGURATION_VERSION_SOURCE_TYPES)[number];

export type ConfigurationSnapshot =
  | null
  | boolean
  | number
  | string
  | ConfigurationSnapshot[]
  | { [key: string]: ConfigurationSnapshot };

export const CONFIGURATION_LIFECYCLE_STATUSES = [
  'DRAFT',
  'VALIDATED',
  'PUBLISHED',
  'ACTIVE',
  'SUPERSEDED',
] as const;
export type ConfigurationLifecycleStatus =
  (typeof CONFIGURATION_LIFECYCLE_STATUSES)[number];

export type ConfigurationValidationError = {
  code: string;
  field: string;
  message: string;
};

export type ConfigurationVersionRecord = {
  id: string;
  sourceType: ConfigurationVersionSourceType;
  sourceConfigurationId: string;
  clientId: string;
  buildingId: string | null;
  versionNumber: number;
  status: string;
  lifecycleStatus: ConfigurationLifecycleStatus;
  previousVersionId: string | null;
  snapshot: ConfigurationSnapshot;
  createdByUserId: string;
  createdAt: Date;
};

export type PublicConfigurationVersion = Omit<
  ConfigurationVersionRecord,
  'createdAt'
> & { createdAt: string };

export type ConfigurationValidationRecord = {
  id: string;
  configurationVersionId: string;
  valid: boolean;
  errors: ConfigurationValidationError[];
  validatedByUserId: string;
  validatedAt: Date;
};

export type PublicConfigurationValidation = Omit<
  ConfigurationValidationRecord,
  'validatedAt'
> & { validatedAt: string };

export type ConfigurationValidationOutcome = {
  version: PublicConfigurationVersion;
  validation: PublicConfigurationValidation;
};

export type CaptureConfigurationVersionInput = {
  sourceType: ConfigurationVersionSourceType;
  sourceConfigurationId: string;
  clientId: string;
  buildingId: string | null;
  status: string;
  snapshot: unknown;
};
