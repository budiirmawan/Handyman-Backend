import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import {
  vendorCategoryCodeAlreadyExistsError,
  vendorCategoryNotFoundError,
} from './vendor-category.errors';
import { vendorCategoryRepository } from './vendor-category.repository';
import type {
  CreateVendorCategoryInput,
  NewVendorCategory,
  PublicVendorCategory,
  UpdateVendorCategoryInput,
  UpdateVendorCategoryStatusInput,
  VendorCategoryRecord,
} from './vendor-category.types';

export function toPublicVendorCategory(
  record: VendorCategoryRecord,
): PublicVendorCategory {
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
 * Creates a Vendor Category in a Client's reference catalog.
 *
 * Validation order (pinned by tests, matching the BE-06A Vendor precedent):
 *   1. unknown Client              → 404 CLIENT_NOT_FOUND
 *   2. INACTIVE Client             → 400 CLIENT_INACTIVE
 *   3. duplicate code for Client   → 409 VENDOR_CATEGORY_CODE_ALREADY_EXISTS
 *
 * The `(client_id, code)` unique constraint remains the final authority — it
 * also covers the race between the pre-check and the INSERT.
 */
export async function createVendorCategory(
  input: CreateVendorCategoryInput,
): Promise<PublicVendorCategory> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  const existing = await vendorCategoryRepository.findByCodeForClient(
    input.clientId,
    input.code,
  );
  if (existing) {
    throw vendorCategoryCodeAlreadyExistsError();
  }

  const newVendorCategory: NewVendorCategory = {
    clientId: input.clientId,
    code: input.code,
    name: input.name,
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record =
      await vendorCategoryRepository.createVendorCategory(newVendorCategory);
    return toPublicVendorCategory(record);
  } catch (error) {
    if (isVendorCategoryCodeUniqueViolation(error)) {
      throw vendorCategoryCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getVendorCategoryById(
  id: string,
): Promise<PublicVendorCategory> {
  const record = await vendorCategoryRepository.findById(id);
  if (!record) {
    throw vendorCategoryNotFoundError();
  }
  return toPublicVendorCategory(record);
}

/**
 * Lists the Vendor Categories of one Client's catalog.
 *
 * The Client is validated first (unknown Client → 404 rather than an empty
 * list) and the query is scoped to `client_id`, so another Client's catalog
 * is never reachable through this route.
 */
export async function listVendorCategoriesByClient(
  clientId: string,
): Promise<PublicVendorCategory[]> {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }

  const records = await vendorCategoryRepository.listByClient(clientId);
  return records.map(toPublicVendorCategory);
}

/**
 * Partially updates a Vendor Category (name, description, status).
 * `clientId` and `code` are deliberately immutable.
 */
export async function updateVendorCategory(
  id: string,
  input: UpdateVendorCategoryInput,
): Promise<PublicVendorCategory> {
  const existing = await vendorCategoryRepository.findById(id);
  if (!existing) {
    throw vendorCategoryNotFoundError();
  }

  const record = await vendorCategoryRepository.updateVendorCategory(id, input);
  return toPublicVendorCategory(record as VendorCategoryRecord);
}

/**
 * Activates or deactivates a Vendor Category. Deactivating is not a delete:
 * existing Vendor classifications survive; the Category simply stops being
 * assignable to further Vendors.
 */
export async function updateVendorCategoryStatus(
  id: string,
  input: UpdateVendorCategoryStatusInput,
): Promise<PublicVendorCategory> {
  const existing = await vendorCategoryRepository.findById(id);
  if (!existing) {
    throw vendorCategoryNotFoundError();
  }

  const record = await vendorCategoryRepository.updateStatus(id, input.status);
  return toPublicVendorCategory(record as VendorCategoryRecord);
}

function isVendorCategoryCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'vendor_categories_client_code_unique'
  );
}

export const vendorCategoryService = {
  createVendorCategory,
  getVendorCategoryById,
  listVendorCategoriesByClient,
  toPublicVendorCategory,
  updateVendorCategory,
  updateVendorCategoryStatus,
};
