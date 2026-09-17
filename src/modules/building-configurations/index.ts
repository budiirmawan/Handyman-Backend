export { createBuildingConfigurationRouter } from './building-configuration.routes';
export {
  buildingConfigurationService,
  createBuildingConfiguration,
  getBuildingConfigurationById,
  getEffectiveBuildingConfiguration,
  listBuildingConfigurations,
  resolveBuildingConfigurationContext,
  resolveBuildingIdentityContext,
  toPublicBuildingConfiguration,
  updateBuildingConfiguration,
} from './building-configuration.service';
export type { BuildingConfigurationContext } from './building-configuration.service';
export type {
  BuildingConfigurationFilters,
  BuildingConfigurationRecord,
  BuildingConfigurationStatus,
  BuildingConfigurationValue,
  CreateBuildingConfigurationInput,
  EffectiveBuildingConfiguration,
  PublicBuildingConfiguration,
  UpdateBuildingConfigurationInput,
} from './building-configuration.types';
