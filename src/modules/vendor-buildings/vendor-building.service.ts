import { AppError } from '../../shared/errors';
import {
  buildingNotFoundError,
  buildingRepository,
  type BuildingRecord,
} from '../buildings';
import { propertyNotFoundError, propertyRepository } from '../properties';
import {
  vendorInactiveError,
  vendorNotFoundError,
  vendorRepository,
} from '../vendors';
import {
  vendorBuildingAlreadyRelatedError,
  vendorBuildingClientMismatchError,
  vendorBuildingInactiveError,
  vendorBuildingRelationshipNotFoundError,
} from './vendor-building.errors';
import { vendorBuildingRepository } from './vendor-building.repository';
import type {
  AssignVendorBuildingInput,
  NewVendorBuildingRelationship,
  PublicVendorBuildingRelationship,
  UpdateVendorBuildingRelationshipInput,
  VendorBuildingRelationshipRecord,
} from './vendor-building.types';

export function toPublicVendorBuildingRelationship(
  record: VendorBuildingRelationshipRecord,
): PublicVendorBuildingRelationship {
  return {
    id: record.id,
    vendorId: record.vendorId,
    buildingId: record.buildingId,
    effectiveFrom: record.effectiveFrom,
    effectiveUntil: record.effectiveUntil,
    status: record.status,
  };
}

/**
 * PostgreSQL unique-violation on the partial ACTIVE index — the
 * race-condition backstop behind the explicit duplicate pre-check.
 */
function isActiveRelationshipUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505' &&
    'constraint' in error &&
    (error as { constraint?: unknown }).constraint ===
      'vendor_building_relationships_active_unique'
  );
}

/**
 * Resolves the Client that authoritatively owns a Building.
 *
 * A Building carries no `client_id`: ownership is derived Building →
 * Property → Client (BE-02). The Building record is returned alongside so
 * callers can apply state rules without a second read.
 */
async function resolveBuilding(buildingId: string): Promise<{
  building: BuildingRecord;
  clientId: string;
}> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    // A Building always points at a real Property (enforced by FK), so this
    // is a data-integrity fault rather than a caller error.
    throw propertyNotFoundError();
  }

  return { building, clientId: property.clientId };
}

/**
 * Resolves and cross-validates both sides of the relationship.
 *
 * Order is deliberate and is what the tests pin down:
 *   1. unknown Vendor     → 404
 *   2. unknown Building   → 404
 *   3. cross-Client pair  → 400 (before any state check, so a foreign
 *                                Building's status is never observable)
 *   4. INACTIVE Building  → 400
 *   5. INACTIVE Vendor    → 400 (only when the result would be an ACTIVE
 *                                relationship; history stays editable)
 *
 * Nothing in this path creates a service scope, workforce binding,
 * compliance document, certification, Work Order, or data-access grant.
 */
async function assertRelatable(
  vendorId: string,
  buildingId: string,
  intendedStatus: 'ACTIVE' | 'INACTIVE',
): Promise<void> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const { building, clientId: buildingClientId } =
    await resolveBuilding(buildingId);

  if (buildingClientId !== vendor.clientId) {
    throw vendorBuildingClientMismatchError();
  }

  if (building.status !== 'ACTIVE') {
    throw vendorBuildingInactiveError();
  }

  if (intendedStatus === 'ACTIVE' && vendor.status !== 'ACTIVE') {
    throw vendorInactiveError();
  }
}

function assertEffectiveOrder(
  effectiveFrom: Date | null,
  effectiveUntil: Date | null,
): void {
  if (
    effectiveFrom !== null &&
    effectiveUntil !== null &&
    effectiveUntil < effectiveFrom
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'effectiveUntil',
        message: 'effectiveUntil must be the same as or after effectiveFrom.',
      },
    ]);
  }
}

/**
 * Relates a Vendor to a Building.
 *
 * A Vendor may serve several Buildings at once and a Building may hold
 * several Vendors; only a duplicate *active* relationship of the same pair
 * is rejected. The row records master data only — it grants no data access
 * and starts no workflow.
 */
export async function assignBuildingToVendor(
  input: AssignVendorBuildingInput,
): Promise<PublicVendorBuildingRelationship> {
  const status = input.status ?? 'ACTIVE';

  await assertRelatable(input.vendorId, input.buildingId, status);

  const effectiveFrom = input.effectiveFrom ?? null;
  const effectiveUntil = input.effectiveUntil ?? null;

  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  if (status === 'ACTIVE') {
    const existing =
      await vendorBuildingRepository.findActiveByVendorAndBuilding(
        input.vendorId,
        input.buildingId,
      );
    if (existing) {
      throw vendorBuildingAlreadyRelatedError();
    }
  }

  const newRelationship: NewVendorBuildingRelationship = {
    vendorId: input.vendorId,
    buildingId: input.buildingId,
    effectiveFrom,
    effectiveUntil,
    status,
  };

  try {
    const record = await vendorBuildingRepository.create(newRelationship);
    return toPublicVendorBuildingRelationship(record);
  } catch (error) {
    if (isActiveRelationshipUniqueViolation(error)) {
      throw vendorBuildingAlreadyRelatedError();
    }
    throw error;
  }
}

/** Lists every Building relationship held by one Vendor. */
export async function listVendorBuildings(
  vendorId: string,
): Promise<PublicVendorBuildingRelationship[]> {
  // Resolving the vendor also proves it exists — unknown ids 404 rather than
  // returning a misleading empty list.
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const records = await vendorBuildingRepository.listByVendorId(vendorId);
  return records.map(toPublicVendorBuildingRelationship);
}

/** Lists every Vendor relationship held by one Building. */
export async function listBuildingVendors(
  buildingId: string,
): Promise<PublicVendorBuildingRelationship[]> {
  // Proves the Building exists so unknown ids 404 instead of returning [].
  await resolveBuilding(buildingId);

  const records = await vendorBuildingRepository.listByBuildingId(buildingId);
  return records.map(toPublicVendorBuildingRelationship);
}

/**
 * Updates the relationship addressed by (vendor, building).
 *
 * Deactivation is expressed as `status: 'INACTIVE'` on this same endpoint;
 * the row is retained so the relationship history stays auditable.
 */
export async function updateVendorBuildingRelationship(
  vendorId: string,
  buildingId: string,
  input: UpdateVendorBuildingRelationshipInput,
): Promise<PublicVendorBuildingRelationship> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const { clientId: buildingClientId } = await resolveBuilding(buildingId);
  if (buildingClientId !== vendor.clientId) {
    throw vendorBuildingClientMismatchError();
  }

  const existing = await vendorBuildingRepository.findByVendorAndBuilding(
    vendorId,
    buildingId,
  );
  if (!existing) {
    throw vendorBuildingRelationshipNotFoundError();
  }

  // Merge against the stored record so a partial update cannot produce an
  // invalid window (e.g. moving only effectiveUntil behind the stored
  // effectiveFrom).
  const effectiveFrom =
    input.effectiveFrom === undefined
      ? existing.effectiveFrom
      : input.effectiveFrom;
  const effectiveUntil =
    input.effectiveUntil === undefined
      ? existing.effectiveUntil
      : input.effectiveUntil;

  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  // Re-activating a historical row must respect the Vendor's state and the
  // one-ACTIVE-per-pair rule.
  if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
    if (vendor.status !== 'ACTIVE') {
      throw vendorInactiveError();
    }

    const active = await vendorBuildingRepository.findActiveByVendorAndBuilding(
      vendorId,
      buildingId,
    );
    if (active && active.id !== existing.id) {
      throw vendorBuildingAlreadyRelatedError();
    }
  }

  try {
    const record = await vendorBuildingRepository.update(existing.id, input);
    return toPublicVendorBuildingRelationship(
      record as VendorBuildingRelationshipRecord,
    );
  } catch (error) {
    if (isActiveRelationshipUniqueViolation(error)) {
      throw vendorBuildingAlreadyRelatedError();
    }
    throw error;
  }
}

export const vendorBuildingService = {
  assignBuildingToVendor,
  listBuildingVendors,
  listVendorBuildings,
  toPublicVendorBuildingRelationship,
  updateVendorBuildingRelationship,
};
