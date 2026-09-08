import {
  assetCategoryNotFoundError,
  assetCategoryRepository,
} from '../asset-categories';
import {
  assetCategoryInactiveForTypeError,
  assetTypeCodeAlreadyExistsError,
  assetTypeNotFoundError,
} from './asset-type.errors';
import { assetTypeRepository } from './asset-type.repository';
import type {
  AssetTypeRecord,
  CreateAssetTypeInput,
  NewAssetType,
  PublicAssetType,
  UpdateAssetTypeInput,
  UpdateAssetTypeStatusInput,
} from './asset-type.types';

export function toPublicAssetType(record: AssetTypeRecord): PublicAssetType {
  return {
    id: record.id,
    assetCategoryId: record.assetCategoryId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

/**
 * Resolves the Client that authoritatively owns an Asset Type
 * (Asset Type → Asset Category → Client).
 *
 * This is the single place Type ownership is derived, so classification
 * isolation can never drift from Category ownership.
 */
export async function resolveAssetTypeClientId(
  record: Pick<AssetTypeRecord, 'assetCategoryId'>,
): Promise<string> {
  const category = await assetCategoryRepository.findById(
    record.assetCategoryId,
  );
  if (!category) {
    // Asset Types always point at a real Category (enforced by FK), so this is
    // a data-integrity fault rather than a caller error.
    throw assetCategoryNotFoundError();
  }
  return category.clientId;
}

/**
 * Creates an Asset Type beneath an Asset Category.
 *
 * Validation order (pinned by tests):
 *   1. unknown Category              → 404 ASSET_CATEGORY_NOT_FOUND
 *   2. INACTIVE Category             → 400 ASSET_CATEGORY_INACTIVE
 *   3. duplicate code for Category   → 409 ASSET_TYPE_CODE_ALREADY_EXISTS
 *
 * The `(asset_category_id, code)` unique constraint remains the final
 * authority — it also covers the race between the pre-check and the INSERT.
 */
export async function createAssetType(
  input: CreateAssetTypeInput,
): Promise<PublicAssetType> {
  const category = await assetCategoryRepository.findById(
    input.assetCategoryId,
  );
  if (!category) {
    throw assetCategoryNotFoundError();
  }
  if (category.status !== 'ACTIVE') {
    throw assetCategoryInactiveForTypeError();
  }

  const existing = await assetTypeRepository.findByCodeForCategory(
    input.assetCategoryId,
    input.code,
  );
  if (existing) {
    throw assetTypeCodeAlreadyExistsError();
  }

  const newType: NewAssetType = {
    assetCategoryId: input.assetCategoryId,
    code: input.code,
    name: input.name,
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await assetTypeRepository.createAssetType(newType);
    return toPublicAssetType(record);
  } catch (error) {
    if (isAssetTypeCodeUniqueViolation(error)) {
      throw assetTypeCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getAssetTypeById(id: string): Promise<PublicAssetType> {
  const record = await assetTypeRepository.findById(id);
  if (!record) {
    throw assetTypeNotFoundError();
  }
  return toPublicAssetType(record);
}

/**
 * Lists the Asset Types beneath one Category.
 *
 * The Category is validated first (unknown Category → 404 rather than an
 * empty list) and the query is scoped to `asset_category_id`, so another
 * Category's types are never reachable through this route.
 */
export async function listAssetTypesByCategory(
  assetCategoryId: string,
): Promise<PublicAssetType[]> {
  const category = await assetCategoryRepository.findById(assetCategoryId);
  if (!category) {
    throw assetCategoryNotFoundError();
  }

  const records = await assetTypeRepository.listByCategory(assetCategoryId);
  return records.map(toPublicAssetType);
}

/**
 * Partially updates an Asset Type (name, description, status).
 *
 * `assetCategoryId` and `code` are deliberately immutable — a Type never
 * migrates between Categories (that would silently re-home the Client
 * ownership derived through it), and its code is the stable identifier
 * Assets point at.
 */
export async function updateAssetType(
  id: string,
  input: UpdateAssetTypeInput,
): Promise<PublicAssetType> {
  const existing = await assetTypeRepository.findById(id);
  if (!existing) {
    throw assetTypeNotFoundError();
  }

  const record = await assetTypeRepository.updateAssetType(id, input);
  return toPublicAssetType(record as AssetTypeRecord);
}

/**
 * Activates or deactivates an Asset Type. Deactivating is not a delete:
 * existing Asset classifications survive; the Type simply stops being
 * assignable to further Assets.
 */
export async function updateAssetTypeStatus(
  id: string,
  input: UpdateAssetTypeStatusInput,
): Promise<PublicAssetType> {
  const existing = await assetTypeRepository.findById(id);
  if (!existing) {
    throw assetTypeNotFoundError();
  }

  const record = await assetTypeRepository.updateStatus(id, input.status);
  return toPublicAssetType(record as AssetTypeRecord);
}

function isAssetTypeCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'asset_types_category_code_unique'
  );
}

export const assetTypeService = {
  createAssetType,
  getAssetTypeById,
  listAssetTypesByCategory,
  resolveAssetTypeClientId,
  toPublicAssetType,
  updateAssetType,
  updateAssetTypeStatus,
};
