export {
  assetWarrantyActiveExistsError,
  assetWarrantyNotFoundError,
  assetWarrantyNumberAlreadyExistsError,
  assetWarrantyOverlapError,
  assetWarrantyStatusDateMismatchError,
} from './asset-warranty.errors';

export { assetWarrantyRepository } from './asset-warranty.repository';

export {
  assetWarrantyService,
  createAssetWarranty,
  getAssetWarrantyById,
  getCurrentAssetWarranty,
  isCurrentlyCovered,
  listAssetWarranties,
  toPublicAssetWarranty,
  today,
  updateAssetWarranty,
  updateAssetWarrantyStatus,
} from './asset-warranty.service';

export {
  ASSET_WARRANTY_STATUSES,
  isAssetWarrantyStatus,
} from './asset-warranty.types';

export {
  isValidCalendarDate,
  normalizeWarrantyNumber,
  parseCreateAssetWarrantyBody,
  parseUpdateAssetWarrantyBody,
  parseUpdateAssetWarrantyStatusBody,
  parseWarrantyAssetIdParam,
  parseWarrantyIdParam,
  parseWarrantyStatusQuery,
} from './asset-warranty.validation';

export type {
  AssetWarrantyRecord,
  AssetWarrantyStatus,
  CreateAssetWarrantyInput,
  NewAssetWarranty,
  PublicAssetWarranty,
  UpdateAssetWarrantyInput,
  UpdateAssetWarrantyStatusInput,
} from './asset-warranty.types';

export type { ValidationDetail } from './asset-warranty.validation';
