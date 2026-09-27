/**
 * CR-HM-04 PART 01 — Handyman Provider Context types (FROZEN F1/F8).
 *
 * The context carries ONLY Handyman eligibility/state: `clientId` is a
 * verbatim snapshot of the authoritative `vendors` row's client at time
 * of creation (the service derives it from the vendor authority, never
 * from caller input). No vendor name/contact/PIC, compliance, capability,
 * or commercial data exists here.
 */

export const HANDYMAN_PROVIDER_CONTEXT_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;
export type HandymanProviderContextStatus =
  (typeof HANDYMAN_PROVIDER_CONTEXT_STATUSES)[number];

export function isHandymanProviderContextStatus(
  value: unknown,
): value is HandymanProviderContextStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_PROVIDER_CONTEXT_STATUSES as readonly string[]).includes(value)
  );
}

export type HandymanProviderContextRecord = {
  id: string;
  /** Tenant isolation root, derived verbatim from the vendor authority. */
  clientId: string;
  /** Authoritative identity: the existing `vendors` master row. */
  vendorId: string;
  status: HandymanProviderContextStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Caller input — clientId/actor are NEVER input. */
export type CreateHandymanProviderContextInput = {
  vendorId: string;
};

export type NewHandymanProviderContextRecord = Omit<
  HandymanProviderContextRecord,
  'id' | 'createdAt' | 'updatedAt' | 'status'
>;

/** Safe public representation (timestamps ISO). */
export type PublicHandymanProviderContext = Omit<
  HandymanProviderContextRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};
