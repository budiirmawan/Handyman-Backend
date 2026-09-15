/**
 * BE-06E — Vendor Service Scope & Capability domain types.
 *
 * A Vendor Capability records what a Vendor is qualified or intended to
 * provide (ELECTRICAL, HVAC, HOUSEKEEPING, …) — DATA, never behavior. A
 * Vendor may hold many capabilities; `code` is unique per Vendor.
 *
 * `vendorBuildingRelationshipId` optionally scopes a capability to one
 * existing BE-06D Vendor ↔ Building relationship (referencing it, never
 * duplicating it). NULL means the capability applies vendor-wide.
 *
 * A capability is a catalog record only — NOT a workforce binding,
 * compliance document, license/certification, Work Order, service
 * execution, or maintenance workflow.
 */
export const VENDOR_CAPABILITY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type VendorCapabilityStatus =
  (typeof VENDOR_CAPABILITY_STATUSES)[number];

export function isVendorCapabilityStatus(
  value: unknown,
): value is VendorCapabilityStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_CAPABILITY_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type VendorCapabilityRecord = {
  id: string;
  vendorId: string;
  code: string;
  name: string;
  description: string | null;
  vendorBuildingRelationshipId: string | null;
  /**
   * CR-BE-SVC-01 PART 03 — governed Service Catalog identity link. NULLABLE:
   * NULL = code-only (legacy capabilities). When set, it references a governed
   * `service_catalog` entry in the Vendor's Client.
   */
  serviceCatalogId: string | null;
  status: VendorCapabilityStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorCapability = {
  id: string;
  vendorId: string;
  code: string;
  name: string;
  description: string | null;
  vendorBuildingRelationshipId: string | null;
  /** CR-BE-SVC-01 PART 03 — governed identity link (nullable). */
  serviceCatalogId: string | null;
  status: VendorCapabilityStatus;
};

export type CreateVendorCapabilityInput = {
  vendorId: string;
  code: string;
  name: string;
  description?: string;
  vendorBuildingRelationshipId?: string | null;
  /** CR-BE-SVC-01 PART 03 — optional governed Service Catalog identity link. */
  serviceCatalogId?: string | null;
  status?: VendorCapabilityStatus;
};

/** Fully-resolved capability data ready for persistence. */
export type NewVendorCapability = {
  vendorId: string;
  code: string;
  name: string;
  description: string | null;
  vendorBuildingRelationshipId: string | null;
  serviceCatalogId: string | null;
  status: VendorCapabilityStatus;
};

/**
 * Partial update. `vendorId` and `code` are deliberately immutable — a
 * capability never migrates between Vendors, and its code is the stable
 * identifier. `vendorBuildingRelationshipId` re-scopes the capability
 * (null returns it to vendor-wide); `status: 'INACTIVE'` deactivates it.
 * `serviceCatalogId` (null clears the governed link) is the PART 03 addition.
 */
export type UpdateVendorCapabilityInput = {
  name?: string;
  description?: string | null;
  vendorBuildingRelationshipId?: string | null;
  /** CR-BE-SVC-01 PART 03 — optional governed link change (null clears it). */
  serviceCatalogId?: string | null;
  status?: VendorCapabilityStatus;
};

export type UpdateVendorCapabilityStatusInput = {
  status: VendorCapabilityStatus;
};
