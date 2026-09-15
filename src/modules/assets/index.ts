export {
  assetBuildingInactiveError,
  assetCodeAlreadyExistsError,
  assetLocationBuildingMismatchError,
  assetLocationInactiveError,
  assetNotFoundError,
  assetRetiredError,
  assetSerialNumberAlreadyExistsError,
  assetStatusTransitionNotAllowedError,
} from './asset.errors';

export { assetRepository } from './asset.repository';

export {
  assertAssetStatusTransition,
  assetService,
  createAsset,
  getAssetById,
  getAssetLifecycleStatus,
  listAssetsByBuilding,
  resolveAssetBuildingContext,
  resolveAssetLocationContext,
  toPublicAsset,
  updateAsset,
  updateAssetLocation,
  updateAssetStatus,
} from './asset.service';

export {
  ASSET_REGISTRABLE_STATUSES,
  ASSET_STATUS_TRANSITIONS,
  ASSET_STATUSES,
  isAllowedAssetStatusTransition,
  isAssetStatus,
  isRegistrableAssetStatus,
  isTerminalAssetStatus,
} from './asset.types';

export {
  isValidAssetCode,
  normalizeAssetCode,
  normalizeSerialNumber,
  parseAssetBuildingIdParam,
  parseAssetIdParam,
  parseAssetStatusQuery,
  parseCreateAssetBody,
  parseUpdateAssetBody,
  parseUpdateAssetLocationBody,
  parseUpdateAssetStatusBody,
} from './asset.validation';

export type {
  AssetLifecycleStatus,
  AssetRecord,
  AssetRegistrableStatus,
  AssetStatus,
  CreateAssetInput,
  NewAsset,
  PublicAsset,
  UpdateAssetInput,
  UpdateAssetLocationInput,
  UpdateAssetStatusInput,
} from './asset.types';

export type { ValidationDetail } from './asset.validation';
