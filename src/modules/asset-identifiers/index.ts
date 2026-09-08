export {
  assetIdentifierActiveTypeExistsError,
  assetIdentifierNotFoundError,
  assetIdentifierNotResolvableError,
  assetIdentifierValueAlreadyExistsError,
} from './asset-identifier.errors';

export { assetIdentifierRepository } from './asset-identifier.repository';

export {
  assetIdentifierService,
  createAssetIdentifier,
  getAssetIdentifierById,
  listAssetIdentifiers,
  resolveAssetByIdentifier,
  toPublicAssetIdentifier,
  updateAssetIdentifier,
  updateAssetIdentifierStatus,
} from './asset-identifier.service';

export {
  ASSET_IDENTIFIER_STATUSES,
  ASSET_IDENTIFIER_TYPES,
  isAssetIdentifierStatus,
  isAssetIdentifierType,
} from './asset-identifier.types';

export {
  generateIdentifierValue,
  isValidIdentifierValue,
  normalizeIdentifierValue,
  parseCreateAssetIdentifierBody,
  parseIdentifierAssetIdParam,
  parseIdentifierIdParam,
  parseIdentifierValueParam,
  parseUpdateAssetIdentifierBody,
  parseUpdateAssetIdentifierStatusBody,
} from './asset-identifier.validation';

export type {
  AssetIdentifierRecord,
  AssetIdentifierStatus,
  AssetIdentifierType,
  CreateAssetIdentifierInput,
  NewAssetIdentifier,
  PublicAssetIdentifier,
  ResolvedAssetIdentifier,
  UpdateAssetIdentifierInput,
  UpdateAssetIdentifierStatusInput,
} from './asset-identifier.types';

export type { ValidationDetail } from './asset-identifier.validation';
