import {
  vendorInactiveError,
  vendorNotFoundError,
  vendorRepository,
} from '../vendors';
import {
  vendorPicInactiveError,
  vendorPicNotFoundError,
} from './vendor-pic.errors';
import { vendorPicRepository } from './vendor-pic.repository';
import type {
  CreateVendorPicInput,
  NewVendorPic,
  PublicVendorPic,
  UpdateVendorPicInput,
  UpdateVendorPicStatusInput,
  VendorPicRecord,
} from './vendor-pic.types';

export function toPublicVendorPic(record: VendorPicRecord): PublicVendorPic {
  return {
    id: record.id,
    vendorId: record.vendorId,
    name: record.name,
    position: record.position,
    email: record.email,
    phone: record.phone,
    isPrimary: record.isPrimary,
    status: record.status,
  };
}

/**
 * Creates a Vendor PIC (contact data only — no User, Credential, Role,
 * Permission, or Workforce Profile is created or modified).
 *
 * Validation order (pinned by tests):
 *   1. unknown Vendor                → 404 VENDOR_NOT_FOUND
 *   2. INACTIVE Vendor               → 400 VENDOR_INACTIVE
 *      (an inactive Vendor receives no new PICs)
 *   3. primary + INACTIVE PIC        → 400 VENDOR_PIC_INACTIVE
 *      (only an ACTIVE PIC can be the primary contact)
 *
 * When the new PIC is primary, the Vendor's current primary is demoted in
 * the same transaction; the partial unique index remains final authority.
 */
export async function createVendorPic(
  input: CreateVendorPicInput,
): Promise<PublicVendorPic> {
  const vendor = await vendorRepository.findById(input.vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }
  if (vendor.status !== 'ACTIVE') {
    throw vendorInactiveError();
  }

  const status = input.status ?? 'ACTIVE';
  const isPrimary = input.isPrimary ?? false;
  if (isPrimary && status !== 'ACTIVE') {
    throw vendorPicInactiveError();
  }

  const newVendorPic: NewVendorPic = {
    vendorId: input.vendorId,
    name: input.name,
    position: input.position ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    isPrimary,
    status,
  };

  const record = await vendorPicRepository.createVendorPic(newVendorPic);
  return toPublicVendorPic(record);
}

export async function getVendorPicById(id: string): Promise<PublicVendorPic> {
  const record = await vendorPicRepository.findById(id);
  if (!record) {
    throw vendorPicNotFoundError();
  }
  return toPublicVendorPic(record);
}

/**
 * Lists the PICs of one Vendor (primary first).
 *
 * The Vendor is validated first (unknown Vendor → 404 rather than an empty
 * list) and the query is scoped to `vendor_id`, so another Vendor's — and
 * therefore another Client's — contacts are never reachable through this
 * route (Client isolation inherited through the Vendor).
 */
export async function listVendorPicsByVendor(
  vendorId: string,
): Promise<PublicVendorPic[]> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const records = await vendorPicRepository.listByVendor(vendorId);
  return records.map(toPublicVendorPic);
}

/**
 * Partially updates a Vendor PIC (contact fields, primary flag, status).
 * `vendorId` is deliberately immutable.
 *
 * Primary consistency rules:
 *   - `isPrimary: true` promotes this PIC and demotes the current primary
 *     (single transaction). The PIC must be — or become — ACTIVE.
 *   - `isPrimary: false` simply demotes it (a Vendor may have no primary).
 *   - Deactivating the current primary PIC automatically demotes it, so an
 *     INACTIVE PIC is never the primary contact.
 */
export async function updateVendorPic(
  id: string,
  input: UpdateVendorPicInput,
): Promise<PublicVendorPic> {
  const existing = await vendorPicRepository.findById(id);
  if (!existing) {
    throw vendorPicNotFoundError();
  }

  const resultingStatus = input.status ?? existing.status;
  const requestedPrimary = input.isPrimary;

  if (requestedPrimary === true && resultingStatus !== 'ACTIVE') {
    throw vendorPicInactiveError();
  }

  const effectiveInput: UpdateVendorPicInput = { ...input };

  // Deactivating the current primary demotes it unless the caller already
  // demoted it explicitly in the same request.
  if (
    resultingStatus === 'INACTIVE' &&
    existing.isPrimary &&
    requestedPrimary === undefined
  ) {
    effectiveInput.isPrimary = false;
  }

  const record = await vendorPicRepository.updateVendorPic(
    id,
    existing.vendorId,
    effectiveInput,
  );
  return toPublicVendorPic(record as VendorPicRecord);
}

/** Activates or deactivates a Vendor PIC (service-level lifecycle helper). */
export async function updateVendorPicStatus(
  id: string,
  input: UpdateVendorPicStatusInput,
): Promise<PublicVendorPic> {
  return updateVendorPic(id, { status: input.status });
}

export const vendorPicService = {
  createVendorPic,
  getVendorPicById,
  listVendorPicsByVendor,
  toPublicVendorPic,
  updateVendorPic,
  updateVendorPicStatus,
};
