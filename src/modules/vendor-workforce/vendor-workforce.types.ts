/**
 * BE-06F — Vendor Workforce Binding domain types.
 *
 * Binds an existing EXTERNAL Workforce Profile (BE-03C/BE-03H) to a Vendor
 * (BE-06A):
 *
 *   Vendor → Vendor Workforce Binding → Workforce Profile
 *
 * The person master remains `workforce_profiles` — this module creates NO
 * second workforce/person master. A Vendor may hold many bound workforce
 * members; a profile holds at most one ACTIVE binding per Vendor.
 *
 * A binding is vendor-context data only. Creating one never creates or
 * modifies a User, Credential, Role, Permission, User Building Access,
 * Workforce Building Assignment, Shift, Skill, or Supervisor.
 *
 * `effectiveFrom` / `effectiveUntil` are both optional: a binding with no
 * window is simply undated and stands until deactivated.
 */
export const VENDOR_WORKFORCE_BINDING_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;

export type VendorWorkforceBindingStatus =
  (typeof VENDOR_WORKFORCE_BINDING_STATUSES)[number];

export function isVendorWorkforceBindingStatus(
  value: unknown,
): value is VendorWorkforceBindingStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_WORKFORCE_BINDING_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type VendorWorkforceBindingRecord = {
  id: string;
  vendorId: string;
  workforceProfileId: string;
  vendorPersonnelCode: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: VendorWorkforceBindingStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorWorkforceBinding = {
  id: string;
  vendorId: string;
  workforceProfileId: string;
  vendorPersonnelCode: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: VendorWorkforceBindingStatus;
};

/** Input supplied by the API consumer when binding workforce to a Vendor. */
export type CreateVendorWorkforceBindingInput = {
  vendorId: string;
  workforceProfileId: string;
  vendorPersonnelCode: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: VendorWorkforceBindingStatus;
};

/** Fully-resolved data ready for persistence. */
export type NewVendorWorkforceBinding = {
  vendorId: string;
  workforceProfileId: string;
  vendorPersonnelCode: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: VendorWorkforceBindingStatus;
};

/** Partial update input. Deactivation is `status: 'INACTIVE'`. */
export type UpdateVendorWorkforceBindingInput = {
  vendorPersonnelCode?: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: VendorWorkforceBindingStatus;
};
