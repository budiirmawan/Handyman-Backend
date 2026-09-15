import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import {
  assetCategoryCodeAlreadyExistsError,
  assetCategoryNotFoundError,
} from './asset-category.errors';
import { assetCategoryRepository } from './asset-category.repository';
import type {
  AssetCategoryRecord,
  CreateAssetCategoryInput,
  NewAssetCategory,
  PublicAssetCategory,
  UpdateAssetCategoryInput,
  UpdateAssetCategoryStatusInput,
} from './asset-category.types';

export function toPublicAssetCategory(
  record: AssetCategoryRecord,
): PublicAssetCategory {
  return {
    id: record.id,
    clientId: record.clientId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

/**
 * Creates an Asset Category in a Client's reference catalog.
 *
 * Validation order (pinned by tests, matching the BE-04E Room Type
 * precedent):
 *   1. unknown Client              → 404 CLIENT_NOT_FOUND
 *   2. INACTIVE Client             → 400 CLIENT_INACTIVE
 *   3. duplicate code for Client   → 409 ASSET_CATEGORY_CODE_ALREADY_EXISTS
 *
 * The `(client_id, code)` unique constraint remains the final authority — it
 * also covers the race between the pre-check and the INSERT.
 */
export async function createAssetCategory(
  input: CreateAssetCategoryInput,
): Promise<PublicAssetCategory> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  const existing = await assetCategoryRepository.findByCodeForClient(
    input.clientId,
    input.code,
  );
  if (existing) {
    throw assetCategoryCodeAlreadyExistsError();
  }

  const newCategory: NewAssetCategory = {
    clientId: input.clientId,
    code: input.code,
    name: input.name,
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await assetCategoryRepository.createAssetCategory(
      newCategory,
    );
    return toPublicAssetCategory(record);
  } catch (error) {
    if (isAssetCategoryCodeUniqueViolation(error)) {
      throw assetCategoryCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getAssetCategoryById(
  id: string,
): Promise<PublicAssetCategory> {
  const record = await assetCategoryRepository.findById(id);
  if (!record) {
    throw assetCategoryNotFoundError();
  }
  return toPublicAssetCategory(record);
}

/**
 * Lists the Asset Categories of one Client's reference catalog.
 *
 * The Client is validated first (unknown Client → 404 rather than an empty
 * list) and the query is scoped to `client_id`, so another Client's catalog
 * is never reachable through this route.
 */
export async function listAssetCategoriesByClient(
  clientId: string,
): Promise<PublicAssetCategory[]> {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }

  const records = await assetCategoryRepository.listByClient(clientId);
  return records.map(toPublicAssetCategory);
}

/**
 * Partially updates an Asset Category (name, description, status).
 *
 * `clientId` and `code` are deliberately immutable — reference data never
 * migrates between Clients, and its code is the stable identifier Assets and
 * Asset Types point at.
 */
export async function updateAssetCategory(
  id: string,
  input: UpdateAssetCategoryInput,
): Promise<PublicAssetCategory> {
  const existing = await assetCategoryRepository.findById(id);
  if (!existing) {
    throw assetCategoryNotFoundError();
  }

  const record = await assetCategoryRepository.updateAssetCategory(id, input);
  return toPublicAssetCategory(record as AssetCategoryRecord);
}

/**
 * Activates or deactivates an Asset Category. Deactivating is not a delete:
 * existing Asset classifications survive; the Category simply stops being
 * assignable to further Assets.
 */
export async function updateAssetCategoryStatus(
  id: string,
  input: UpdateAssetCategoryStatusInput,
): Promise<PublicAssetCategory> {
  const existing = await assetCategoryRepository.findById(id);
  if (!existing) {
    throw assetCategoryNotFoundError();
  }

  const record = await assetCategoryRepository.updateStatus(id, input.status);
  return toPublicAssetCategory(record as AssetCategoryRecord);
}

function isAssetCategoryCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'asset_categories_client_code_unique'
  );
}

export const assetCategoryService = {
  createAssetCategory,
  getAssetCategoryById,
  listAssetCategoriesByClient,
  toPublicAssetCategory,
  updateAssetCategory,
  updateAssetCategoryStatus,
};
