/**
 * BE-06B — Vendor Category domain types.
 *
 * A Vendor Category is Client-scoped classification/reference data for
 * Vendors (e.g. ENGINEERING, HOUSEKEEPING, SECURITY, HVAC). It classifies a
 * Vendor via the optional `vendors.vendor_category_id` — it is NOT a PIC,
 * building relationship, service scope, workforce binding, compliance, or
 * certification record, and it carries no workflow.
 */
export const VENDOR_CATEGORY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type VendorCategoryStatus = (typeof VENDOR_CATEGORY_STATUSES)[number];

export function isVendorCategoryStatus(
  value: unknown,
): value is VendorCategoryStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_CATEGORY_STATUSES as readonly string[]).includes(value)
  );
}

export type VendorCategoryRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: VendorCategoryStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorCategory = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: VendorCategoryStatus;
};

export type CreateVendorCategoryInput = {
  clientId: string;
  code: string;
  name: string;
  description?: string;
  status?: VendorCategoryStatus;
};

/** Fully-resolved category data ready for persistence. */
export type NewVendorCategory = {
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: VendorCategoryStatus;
};

/**
 * Partial update. `clientId` and `code` are deliberately immutable —
 * reference data never migrates between Clients, and its code is the stable
 * identifier Vendors point at.
 */
export type UpdateVendorCategoryInput = {
  name?: string;
  description?: string | null;
  status?: VendorCategoryStatus;
};

export type UpdateVendorCategoryStatusInput = {
  status: VendorCategoryStatus;
};
