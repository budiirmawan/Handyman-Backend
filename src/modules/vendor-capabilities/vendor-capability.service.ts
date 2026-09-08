import {
  vendorBuildingRelationshipNotFoundError,
  vendorBuildingRepository,
} from '../vendor-buildings';
import {
  vendorInactiveError,
  vendorNotFoundError,
  vendorRepository,
} from '../vendors';
import { serviceCatalogRepository } from '../service-catalog';
import {
  vendorCapabilityCatalogClientMismatchError,
  vendorCapabilityCatalogInactiveError,
  vendorCapabilityCatalogNotFoundError,
  vendorCapabilityCodeAlreadyExistsError,
  vendorCapabilityNotFoundError,
  vendorCapabilityRelationshipInactiveError,
  vendorCapabilityRelationshipMismatchError,
} from './vendor-capability.errors';
import { vendorCapabilityRepository } from './vendor-capability.repository';
import type {
  CreateVendorCapabilityInput,
  NewVendorCapability,
  PublicVendorCapability,
  UpdateVendorCapabilityInput,
  UpdateVendorCapabilityStatusInput,
  VendorCapabilityRecord,
} from './vendor-capability.types';

export function toPublicVendorCapability(
  record: VendorCapabilityRecord,
): PublicVendorCapability {
  return {
    id: record.id,
    vendorId: record.vendorId,
    code: record.code,
    name: record.name,
    description: record.description,
    vendorBuildingRelationshipId: record.vendorBuildingRelationshipId,
    serviceCatalogId: record.serviceCatalogId,
    status: record.status,
  };
}

/**
 * CR-BE-SVC-01 PART 03 — validates a governed Service Catalog identity link.
 *
 * When `serviceCatalogId` is supplied, it must (governance §7):
 *   1. resolve to an existing catalog entry   → 404 VENDOR_CAPABILITY_CATALOG_NOT_FOUND
 *   2. belong to the Vendor's Client           → 400 VENDOR_CAPABILITY_CATALOG_CLIENT_MISMATCH
 *   3. be ACTIVE for a new/changed assignment  → 400 VENDOR_CAPABILITY_CATALOG_INACTIVE
 *
 * The capability `code` is never rewritten. A NULL / absent link means the
 * capability relies on its free-text `code` only (legacy capabilities).
 * Returns the validated catalog id (or null when the link is cleared).
 */
async function resolveServiceCatalogLink(
  vendorClientId: string,
  linkId: string | null,
): Promise<string | null> {
  if (linkId === null) {
    return null;
  }
  const catalog = await serviceCatalogRepository.findById(undefined, linkId);
  if (!catalog) {
    throw vendorCapabilityCatalogNotFoundError();
  }
  if (catalog.clientId !== vendorClientId) {
    throw vendorCapabilityCatalogClientMismatchError();
  }
  if (catalog.status !== 'ACTIVE') {
    throw vendorCapabilityCatalogInactiveError();
  }
  return catalog.id;
}

/**
 * Validates an optional Building scope reference.
 *
 * The capability points at an existing BE-06D Vendor ↔ Building relationship
 * rather than a Building directly, so the relationship is never duplicated
 * and Client/Building isolation is inherited from it. Rules, in order:
 *   1. unknown relationship            → 404 VENDOR_BUILDING_RELATIONSHIP_NOT_FOUND
 *   2. relationship of another Vendor  → 400 VENDOR_CAPABILITY_RELATIONSHIP_MISMATCH
 *   3. INACTIVE relationship           → 400 VENDOR_CAPABILITY_RELATIONSHIP_INACTIVE
 *      (existing scope survives a later deactivation; only NEW scoping is
 *      rejected)
 */
async function assertScopableRelationship(
  vendorId: string,
  vendorBuildingRelationshipId: string,
): Promise<void> {
  const relationship = await vendorBuildingRepository.findById(
    vendorBuildingRelationshipId,
  );
  if (!relationship) {
    throw vendorBuildingRelationshipNotFoundError();
  }
  if (relationship.vendorId !== vendorId) {
    throw vendorCapabilityRelationshipMismatchError();
  }
  if (relationship.status !== 'ACTIVE') {
    throw vendorCapabilityRelationshipInactiveError();
  }
}

/**
 * Adds a capability to a Vendor's service scope catalog.
 *
 * Validation order (pinned by tests, matching the BE-06C precedent):
 *   1. unknown Vendor              → 404 VENDOR_NOT_FOUND
 *   2. INACTIVE Vendor             → 400 VENDOR_INACTIVE
 *      (an inactive Vendor receives no new active capability)
 *   3. Building scope rules        → see assertScopableRelationship
 *   4. duplicate code for Vendor   → 409 VENDOR_CAPABILITY_CODE_ALREADY_EXISTS
 *
 * The `(vendor_id, code)` unique constraint remains the final authority —
 * it also covers the race between the pre-check and the INSERT.
 */
export async function createVendorCapability(
  input: CreateVendorCapabilityInput,
): Promise<PublicVendorCapability> {
  const vendor = await vendorRepository.findById(input.vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const status = input.status ?? 'ACTIVE';
  if (status === 'ACTIVE' && vendor.status !== 'ACTIVE') {
    throw vendorInactiveError();
  }

  const vendorBuildingRelationshipId =
    input.vendorBuildingRelationshipId ?? null;
  if (vendorBuildingRelationshipId !== null) {
    await assertScopableRelationship(
      input.vendorId,
      vendorBuildingRelationshipId,
    );
  }

  const existing = await vendorCapabilityRepository.findByCodeForVendor(
    input.vendorId,
    input.code,
  );
  if (existing) {
    throw vendorCapabilityCodeAlreadyExistsError();
  }

  // CR-BE-SVC-01 PART 03 — governed Service Catalog identity link. Same Client
  // as the Vendor, ACTIVE. The capability code is never rewritten.
  const serviceCatalogId = await resolveServiceCatalogLink(
    vendor.clientId,
    input.serviceCatalogId === undefined ? null : input.serviceCatalogId,
  );

  const newCapability: NewVendorCapability = {
    vendorId: input.vendorId,
    code: input.code,
    name: input.name,
    description: input.description?.trim() || null,
    vendorBuildingRelationshipId,
    serviceCatalogId,
    status,
  };

  try {
    const record =
      await vendorCapabilityRepository.createVendorCapability(newCapability);
    return toPublicVendorCapability(record);
  } catch (error) {
    if (isCapabilityCodeUniqueViolation(error)) {
      throw vendorCapabilityCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getVendorCapabilityById(
  id: string,
): Promise<PublicVendorCapability> {
  const record = await vendorCapabilityRepository.findById(id);
  if (!record) {
    throw vendorCapabilityNotFoundError();
  }
  return toPublicVendorCapability(record);
}

/**
 * Lists the capabilities of one Vendor.
 *
 * The Vendor is validated first (unknown Vendor → 404 rather than an empty
 * list) and the query is scoped to `vendor_id`, so another Vendor's — and
 * therefore another Client's — catalog is never reachable through this
 * route (Client isolation inherited through the Vendor).
 */
export async function listVendorCapabilitiesByVendor(
  vendorId: string,
): Promise<PublicVendorCapability[]> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const records = await vendorCapabilityRepository.listByVendor(vendorId);
  return records.map(toPublicVendorCapability);
}

/**
 * Partially updates a capability (name, description, Building scope,
 * status). `vendorId` and `code` are deliberately immutable. Deactivation
 * is `status: 'INACTIVE'` — the row is retained so the catalog history
 * stays auditable.
 */
export async function updateVendorCapability(
  id: string,
  input: UpdateVendorCapabilityInput,
): Promise<PublicVendorCapability> {
  const existing = await vendorCapabilityRepository.findById(id);
  if (!existing) {
    throw vendorCapabilityNotFoundError();
  }

  if (
    input.vendorBuildingRelationshipId !== undefined &&
    input.vendorBuildingRelationshipId !== null &&
    input.vendorBuildingRelationshipId !== existing.vendorBuildingRelationshipId
  ) {
    await assertScopableRelationship(
      existing.vendorId,
      input.vendorBuildingRelationshipId,
    );
  }

  // Re-activating a capability must respect the Vendor's state.
  if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
    const vendor = await vendorRepository.findById(existing.vendorId);
    if (vendor && vendor.status !== 'ACTIVE') {
      throw vendorInactiveError();
    }
  }

  // CR-BE-SVC-01 PART 03 — governed Service Catalog identity link. Enforced
  // only when service_catalog_id is supplied (null clears the link). The link
  // must belong to the Vendor's Client and be ACTIVE for a new/changed
  // assignment. The capability code is never rewritten.
  let serviceCatalogId = existing.serviceCatalogId;
  if (input.serviceCatalogId !== undefined) {
    const vendor = await vendorRepository.findById(existing.vendorId);
    if (!vendor) {
      throw vendorNotFoundError();
    }
    serviceCatalogId = await resolveServiceCatalogLink(
      vendor.clientId,
      input.serviceCatalogId,
    );
  }

  const record = await vendorCapabilityRepository.updateVendorCapability(
    id,
    { ...input, serviceCatalogId: input.serviceCatalogId === undefined ? undefined : serviceCatalogId },
  );
  return toPublicVendorCapability(record as VendorCapabilityRecord);
}

/** Activates or deactivates a capability (service-level lifecycle helper). */
export async function updateVendorCapabilityStatus(
  id: string,
  input: UpdateVendorCapabilityStatusInput,
): Promise<PublicVendorCapability> {
  return updateVendorCapability(id, { status: input.status });
}

function isCapabilityCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'vendor_capabilities_vendor_code_unique'
  );
}

export const vendorCapabilityService = {
  createVendorCapability,
  getVendorCapabilityById,
  listVendorCapabilitiesByVendor,
  toPublicVendorCapability,
  updateVendorCapability,
  updateVendorCapabilityStatus,
};
