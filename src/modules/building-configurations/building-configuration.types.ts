import type {
  ClientConfigurationStatus,
  ClientConfigurationValue,
} from '../client-configurations';

/** BE-27B reuses BE-27A's key/value availability contract verbatim. */
export type BuildingConfigurationStatus = ClientConfigurationStatus;
export type BuildingConfigurationValue = ClientConfigurationValue;

export type BuildingConfigurationRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  key: string;
  value: BuildingConfigurationValue;
  status: BuildingConfigurationStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicBuildingConfiguration = Omit<
  BuildingConfigurationRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

export type CreateBuildingConfigurationInput = {
  buildingId: string;
  key: string;
  value: BuildingConfigurationValue;
  status?: BuildingConfigurationStatus;
};

export type NewBuildingConfiguration = {
  buildingId: string;
  key: string;
  value: BuildingConfigurationValue;
  status: BuildingConfigurationStatus;
};

export type UpdateBuildingConfigurationInput = {
  value?: BuildingConfigurationValue;
  status?: BuildingConfigurationStatus;
};

export type BuildingConfigurationFilters = {
  status?: BuildingConfigurationStatus;
};

/**
 * Effective Building configuration is BE-27A ACTIVE Client values overlaid by
 * ACTIVE values for this Building. A Building key wins on collision.
 */
export type EffectiveBuildingConfiguration = {
  clientId: string;
  buildingId: string;
  configurations: Record<string, BuildingConfigurationValue>;
};
