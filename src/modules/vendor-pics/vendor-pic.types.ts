/**
 * BE-06C — Vendor PIC domain types.
 *
 * A Vendor PIC (person in charge / contact person) is CONTACT DATA belonging
 * to one Vendor (Vendor → Vendor PIC). A Vendor may hold multiple PICs; at
 * most one is the primary contact. A PIC is NOT an identity: creating one
 * never creates or modifies a User, Credential, Role, Permission, or
 * Workforce Profile.
 */
export const VENDOR_PIC_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type VendorPicStatus = (typeof VENDOR_PIC_STATUSES)[number];

export function isVendorPicStatus(value: unknown): value is VendorPicStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_PIC_STATUSES as readonly string[]).includes(value)
  );
}

export type VendorPicRecord = {
  id: string;
  vendorId: string;
  name: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  status: VendorPicStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorPic = {
  id: string;
  vendorId: string;
  name: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  status: VendorPicStatus;
};

export type CreateVendorPicInput = {
  vendorId: string;
  name: string;
  position?: string;
  email?: string;
  phone?: string;
  isPrimary?: boolean;
  status?: VendorPicStatus;
};

/** Fully-resolved PIC data ready for persistence. */
export type NewVendorPic = {
  vendorId: string;
  name: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  status: VendorPicStatus;
};

/**
 * Partial update. `vendorId` is deliberately immutable — a PIC never
 * migrates between Vendors. `null` clears an optional field.
 * `isPrimary: true` promotes this PIC (demoting the current primary);
 * `isPrimary: false` demotes it.
 */
export type UpdateVendorPicInput = {
  name?: string;
  position?: string | null;
  email?: string | null;
  phone?: string | null;
  isPrimary?: boolean;
  status?: VendorPicStatus;
};

export type UpdateVendorPicStatusInput = {
  status: VendorPicStatus;
};
