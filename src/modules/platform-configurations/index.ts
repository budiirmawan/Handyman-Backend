/**
 * CR-BE-SAAS-01 PART 12 — Platform Configuration module index.
 *
 * PART 12A (domain-only) extended the existing
 * `platform_configurations` JSONB table with a typed catalogue +
 * resolver + OCC + audit path. PART 12B adds the HTTP routes
 * (frozen §22), validation, and the controller. PART 12A did NOT
 * mutate any existing PART 08/10/11 readers — they continue to
 * work directly against `platform_configurations`. This module is
 * now the authoritative path for new code AND for the §22 routes
 * PART 12B introduces.
 */
export {
  resolveConfiguration,
  getConfiguration,
  listAllConfigurations,
  validateValue,
  updateConfiguration,
  createConfiguration,
  isKnownConfigurationKey,
} from './platform-configuration.service';

export {
  validatePlatformConfigValue,
  assertValidPlatformConfigValue,
} from './platform-configuration.validation';

export {
  parseCreateConfigurationBody,
  parseUpdateConfigurationBody,
  type ParsedCreateConfigurationBody,
  type ParsedUpdateConfigurationBody,
} from './platform-configuration.body-validation';

export {
  PLATFORM_CONFIGURATION_CATALOGUE,
  SAAS_PLATFORM_CONFIGURATION_KEYS,
  PLATFORM_CONFIGURATION_ENTITY_TYPE,
  PLATFORM_CONFIGURATION_AUDIT_EVENT,
  entityIdForKey,
  type PlatformConfigKeyDescriptor,
  type PlatformConfigValueShape,
  type PlatformConfigurationRecord,
  type PlatformConfigurationChange,
  type SaaSPlatformConfigurationKey,
  type UpdatePlatformConfigurationInput,
  type CreatePlatformConfigurationInput,
} from './platform-configuration.types';

export { platformConfigurationRepository } from './platform-configuration.repository';

export { createPlatformConfigurationRouter } from './platform-configuration.routes';
export {
  listPlatformConfigurationHandler,
  getPlatformConfigurationHandler,
  createPlatformConfigurationHandler,
  updatePlatformConfigurationHandler,
  type PlatformConfigurationPublic,
} from './platform-configuration.controller';
