/**
 * BE-06A — Vendor domain types.
 *
 * A Vendor is Client-scoped master data for an external organization /
 * service provider (Client → Vendor). It is NOT a classification, PIC,
 * building relationship, service scope, workforce binding, compliance
 * document, or license record — those arrive in later BE-06 PARTs — and it
 * carries no procurement, billing, or operational workflow.
 */
export const VENDOR_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type VendorStatus = (typeof VENDOR_STATUSES)[number];

export function isVendorStatus(value: unknown): value is VendorStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_STATUSES as readonly string[]).includes(value)
  );
}

export type VendorRecord = {
  id: string;
  clientId: string;
  vendorCode: string;
  vendorName: string;
  legalName: string | null;
  registrationNumber: string | null;
  taxNumber: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  /** BE-06B — optional Vendor Category classification; null = unclassified. */
  vendorCategoryId: string | null;
  status: VendorStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendor = {
  id: string;
  clientId: string;
  vendorCode: string;
  vendorName: string;
  legalName: string | null;
  registrationNumber: string | null;
  taxNumber: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  /** BE-06B — optional Vendor Category classification; null = unclassified. */
  vendorCategoryId: string | null;
  status: VendorStatus;
};

export type CreateVendorInput = {
  clientId: string;
  vendorCode: string;
  vendorName: string;
  legalName?: string;
  registrationNumber?: string;
  taxNumber?: string;
  email?: string;
  phone?: string;
  address?: string;
  status?: VendorStatus;
};

/** Fully-resolved vendor data ready for persistence. */
export type NewVendor = {
  clientId: string;
  vendorCode: string;
  vendorName: string;
  legalName: string | null;
  registrationNumber: string | null;
  taxNumber: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: VendorStatus;
};

/**
 * Partial update. `clientId` and `vendorCode` are deliberately immutable —
 * a Vendor never migrates between Clients, and its code is the stable
 * identifier later BE-06 PARTs point at. `null` clears an optional field.
 *
 * `vendorCategoryId` (BE-06B) assigns a classification; explicit null clears
 * it. The service enforces same-Client and ACTIVE-Category rules.
 */
export type UpdateVendorInput = {
  vendorName?: string;
  legalName?: string | null;
  registrationNumber?: string | null;
  taxNumber?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  vendorCategoryId?: string | null;
  status?: VendorStatus;
};

export type UpdateVendorStatusInput = {
  status: VendorStatus;
};
