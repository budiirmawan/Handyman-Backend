/**
 * BE-06D — Vendor Building Relationship domain types.
 *
 * Connects an existing Vendor (BE-06A) to an existing Building (BE-02E):
 *
 *   Vendor → Vendor Building Relationship → Building
 *
 * One Vendor may serve several Buildings and one Building may be served by
 * several Vendors. The relationship is master data only — it is NOT a
 * service scope, workforce binding, compliance document, certification,
 * Work Order, or maintenance workflow, and it grants no data access
 * (BE-02F `user_building_assignments` remains the only access table).
 *
 * `effectiveFrom` / `effectiveUntil` are both optional: a relationship with
 * no window is simply undated and stands until deactivated.
 */
export const VENDOR_BUILDING_RELATIONSHIP_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;

export type VendorBuildingRelationshipStatus =
  (typeof VENDOR_BUILDING_RELATIONSHIP_STATUSES)[number];

export function isVendorBuildingRelationshipStatus(
  value: unknown,
): value is VendorBuildingRelationshipStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_BUILDING_RELATIONSHIP_STATUSES as readonly string[]).includes(
      value,
    )
  );
}

/** Full database record. */
export type VendorBuildingRelationshipRecord = {
  id: string;
  vendorId: string;
  buildingId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: VendorBuildingRelationshipStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorBuildingRelationship = {
  id: string;
  vendorId: string;
  buildingId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: VendorBuildingRelationshipStatus;
};

/** Input supplied by the API consumer when assigning a Building. */
export type AssignVendorBuildingInput = {
  vendorId: string;
  buildingId: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: VendorBuildingRelationshipStatus;
};

/** Fully-resolved data ready for persistence. */
export type NewVendorBuildingRelationship = {
  vendorId: string;
  buildingId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: VendorBuildingRelationshipStatus;
};

/** Partial update input. Deactivation is `status: 'INACTIVE'`. */
export type UpdateVendorBuildingRelationshipInput = {
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: VendorBuildingRelationshipStatus;
};
