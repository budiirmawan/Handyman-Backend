export {
  assetCategoryInactiveForTypeError,
  assetTypeCategoryMismatchError,
  assetTypeCodeAlreadyExistsError,
  assetTypeInactiveError,
  assetTypeNotFoundError,
} from './asset-type.errors';

export { assetTypeRepository } from './asset-type.repository';

export {
  assetTypeService,
  createAssetType,
  getAssetTypeById,
  listAssetTypesByCategory,
  resolveAssetTypeClientId,
  toPublicAssetType,
  updateAssetType,
  updateAssetTypeStatus,
} from './asset-type.service';

export { ASSET_TYPE_STATUSES, isAssetTypeStatus } from './asset-type.types';

export {
  isValidAssetTypeCode,
  normalizeAssetTypeCode,
  parseAssetTypeCategoryIdParam,
  parseAssetTypeIdParam,
  parseCreateAssetTypeBody,
  parseUpdateAssetTypeBody,
  parseUpdateAssetTypeStatusBody,
} from './asset-type.validation';

export type {
  AssetTypeRecord,
  AssetTypeStatus,
  CreateAssetTypeInput,
  NewAssetType,
  PublicAssetType,
  UpdateAssetTypeInput,
  UpdateAssetTypeStatusInput,
} from './asset-type.types';

export type { ValidationDetail } from './asset-type.validation';
