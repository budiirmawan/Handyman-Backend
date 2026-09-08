import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import {
  vendorCategoryClientMismatchError,
  vendorCategoryInactiveError,
  vendorCategoryNotFoundError,
  vendorCategoryRepository,
} from '../vendor-categories';
import {
  vendorCodeAlreadyExistsError,
  vendorNotFoundError,
} from './vendor.errors';
import { vendorRepository } from './vendor.repository';
import type {
  CreateVendorInput,
  NewVendor,
  PublicVendor,
  UpdateVendorInput,
  UpdateVendorStatusInput,
  VendorRecord,
} from './vendor.types';

export function toPublicVendor(record: VendorRecord): PublicVendor {
  return {
    id: record.id,
    clientId: record.clientId,
    vendorCode: record.vendorCode,
    vendorName: record.vendorName,
    legalName: record.legalName,
    registrationNumber: record.registrationNumber,
    taxNumber: record.taxNumber,
    email: record.email,
    phone: record.phone,
    address: record.address,
    vendorCategoryId: record.vendorCategoryId,
    status: record.status,
  };
}

/**
 * Creates a Vendor in a Client's registry.
 *
 * Validation order (pinned by tests, matching the BE-02D Property precedent):
 *   1. unknown Client                    → 404 CLIENT_NOT_FOUND
 *   2. INACTIVE Client                   → 400 CLIENT_INACTIVE
 *   3. duplicate vendor_code for Client  → 409 VENDOR_CODE_ALREADY_EXISTS
 *
 * The `(client_id, vendor_code)` unique constraint remains the final
 * authority — it also covers the race between the pre-check and the INSERT.
 */
export async function createVendor(
  input: CreateVendorInput,
): Promise<PublicVendor> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  const existing = await vendorRepository.findByCodeForClient(
    input.clientId,
    input.vendorCode,
  );
  if (existing) {
    throw vendorCodeAlreadyExistsError();
  }

  const newVendor: NewVendor = {
    clientId: input.clientId,
    vendorCode: input.vendorCode,
    vendorName: input.vendorName,
    legalName: input.legalName ?? null,
    registrationNumber: input.registrationNumber ?? null,
    taxNumber: input.taxNumber ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    address: input.address ?? null,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await vendorRepository.createVendor(newVendor);
    return toPublicVendor(record);
  } catch (error) {
    if (isVendorCodeUniqueViolation(error)) {
      throw vendorCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getVendorById(id: string): Promise<PublicVendor> {
  const record = await vendorRepository.findById(id);
  if (!record) {
    throw vendorNotFoundError();
  }
  return toPublicVendor(record);
}

/**
 * Lists the Vendors of one Client's registry.
 *
 * The Client is validated first (unknown Client → 404 rather than an empty
 * list) and the query is scoped to `client_id`, so another Client's vendors
 * are never reachable through this route.
 */
export async function listVendorsByClient(
  clientId: string,
): Promise<PublicVendor[]> {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }

  const records = await vendorRepository.listByClient(clientId);
  return records.map(toPublicVendor);
}

/**
 * Partially updates a Vendor (name, legal/registration/tax identity, contact,
 * address, classification, status). `clientId` and `vendorCode` are
 * deliberately immutable.
 *
 * Classification assignment (BE-06B — `vendorCategoryId` set to an id; null
 * clears it) enforces, in order:
 *   1. unknown Category            → 404 VENDOR_CATEGORY_NOT_FOUND
 *   2. Category of another Client  → 400 VENDOR_CATEGORY_CLIENT_MISMATCH
 *   3. INACTIVE Category           → 400 VENDOR_CATEGORY_INACTIVE
 *
 * An already-assigned classification survives its Category being
 * deactivated; only NEW assignments of an inactive Category are rejected.
 */
export async function updateVendor(
  id: string,
  input: UpdateVendorInput,
): Promise<PublicVendor> {
  const existing = await vendorRepository.findById(id);
  if (!existing) {
    throw vendorNotFoundError();
  }

  if (input.vendorCategoryId !== undefined && input.vendorCategoryId !== null) {
    const category = await vendorCategoryRepository.findById(
      input.vendorCategoryId,
    );
    if (!category) {
      throw vendorCategoryNotFoundError();
    }
    if (category.clientId !== existing.clientId) {
      throw vendorCategoryClientMismatchError();
    }
    if (category.status !== 'ACTIVE') {
      throw vendorCategoryInactiveError();
    }
  }

  const record = await vendorRepository.updateVendor(id, input);
  return toPublicVendor(record as VendorRecord);
}

/**
 * Activates or deactivates a Vendor. Deactivating is not a delete: the
 * master record and its history survive; the Vendor simply stops being
 * referenced by future BE-06 relationships.
 */
export async function updateVendorStatus(
  id: string,
  input: UpdateVendorStatusInput,
): Promise<PublicVendor> {
  const existing = await vendorRepository.findById(id);
  if (!existing) {
    throw vendorNotFoundError();
  }

  const record = await vendorRepository.updateStatus(id, input.status);
  return toPublicVendor(record as VendorRecord);
}

function isVendorCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'vendors_client_vendor_code_unique'
  );
}

export const vendorService = {
  createVendor,
  getVendorById,
  listVendorsByClient,
  toPublicVendor,
  updateVendor,
  updateVendorStatus,
};
