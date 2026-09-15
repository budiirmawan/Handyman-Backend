/**
 * CR-HM-BE-02 RUN 1 — Handyman Provider designation types.
 *
 * A designation is the bounded-context role binding that marks an existing
 * BE-06A Vendor as a Handyman Provider for that Vendor's Client. It carries
 * identity and lifecycle only: no building scope (BE-06D
 * `vendor_building_relationships` remains the Provider ↔ Building authority)
 * and no service fields (BE-06E `vendor_capabilities` + the CR-BE-SVC-01
 * `service_catalog_id` link remain the eligibility authority).
 */

export const HANDYMAN_PROVIDER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type HandymanProviderStatus = (typeof HANDYMAN_PROVIDER_STATUSES)[number];

export function isHandymanProviderStatus(
  value: unknown,
): value is HandymanProviderStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_PROVIDER_STATUSES as readonly string[]).includes(value)
  );
}

/** Persisted row shape returned by the repository. */
export type HandymanProviderRecord = {
  id: string;
  clientId: string;
  vendorId: string;
  status: HandymanProviderStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed to callers. */
export type PublicHandymanProvider = {
  id: string;
  clientId: string;
  vendorId: string;
  status: HandymanProviderStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Designation command input. `createdByUserId` is deliberately absent: the
 * creating actor identity always comes from the authenticated actor in the
 * service layer, never from the request payload.
 */
export type CreateHandymanProviderInput = {
  clientId: string;
  vendorId: string;
};

export type UpdateHandymanProviderStatusInput = {
  status: HandymanProviderStatus;
};

/** Fully-resolved designation data ready for persistence. */
export type NewHandymanProvider = {
  clientId: string;
  vendorId: string;
  status: HandymanProviderStatus;
  createdByUserId: string;
};

export type HandymanProviderFilters = {
  status?: HandymanProviderStatus;
};
