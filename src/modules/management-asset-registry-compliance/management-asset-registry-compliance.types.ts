import type { AssetStatus } from '../assets';
import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';

export type ManagementAssetRegistryComplianceQuery = {
  scope: ManagementReadScopeFilters;
  expiringWithinDays: number;
};

export type ManagementAssetRegistryComplianceFilters = {
  expiringWithinDays: number;
};

export type ManagementAssetLocationSummary = {
  buildingId: string;
  locationType: 'BUILDING' | 'FUNCTIONAL_LOCATION';
  functionalLocationId: string | null;
  functionalLocationCode: string | null;
  functionalLocationName: string | null;
  functionalLocationStatus: string | null;
  assetCount: number;
};

export type ManagementAssetRegistryComplianceData = {
  totalAssets: number;
  activeAssets: number;
  inactiveAssets: number;
  assetStatus: Record<AssetStatus, number>;
  warranties: {
    totalRecords: number;
    active: number;
    expired: number;
    inactive: number;
    currentlyCoveredAssets: number;
    assetsWithoutCurrentCoverage: number;
  };
  certifications: {
    totalRecords: number;
    active: number;
    expired: number;
    inactive: number;
    currentlyEffectiveRecords: number;
    assetsWithEffectiveCertification: number;
    assetsWithoutEffectiveCertification: number;
    expiredComplianceCount: number;
    expiringComplianceCount: number;
  };
  locations: ManagementAssetLocationSummary[];
};

export type PublicManagementAssetRegistryCompliance =
  ManagementReadModelContract<
    ManagementAssetRegistryComplianceData,
    ManagementAssetRegistryComplianceFilters
  >;
