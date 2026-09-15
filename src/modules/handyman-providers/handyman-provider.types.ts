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

/**
 * CR-HM-BE-02 RUN 2 — domain read models.
 *
 * Shapes sufficient for the Run 3 HTTP exposure. `entitled` /
 * `configuredEnabled` mirror the existing BE-27C effective-projection
 * convention (public through the existing module-configuration effective
 * endpoints); everything else is Handyman-domain vocabulary. No internal
 * subscription/license/entitlement/configuration records are exposed.
 */

/** Effective Handyman state of one Building (fail closed by construction). */
export type BuildingHandymanEnablement = {
  buildingId: string;
  clientId: string;
  /** Authoritative flag: commercial entitlement AND effective configuration. */
  enabled: boolean;
  /** Diagnostic: effective commercial HANDYMAN right (BE-02C chain). */
  entitled: boolean;
  /** Diagnostic: effective configuration intent (BE-27C projection). */
  configuredEnabled: boolean;
};

/** One designated Provider authorized to serve one Building right now. */
export type AuthorizedHandymanProvider = {
  /** `handyman_providers` designation id. */
  providerId: string;
  buildingId: string;
  clientId: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  /** The authorizing BE-06D `vendor_building_relationships` row. */
  relationshipId: string;
};

/** How a capability scopes to Buildings (BE-06E semantics). */
export const HANDYMAN_CAPABILITY_SCOPES = ['VENDOR_WIDE', 'BUILDING_SCOPED'] as const;

export type HandymanCapabilityScope = (typeof HANDYMAN_CAPABILITY_SCOPES)[number];

/** One eligible Service Catalog service for one authorized Provider at one Building. */
export type HandymanProviderServiceEligibility = {
  providerId: string;
  buildingId: string;
  vendorId: string;
  capabilityId: string;
  capabilityScope: HandymanCapabilityScope;
  serviceCatalogId: string;
  serviceCode: string;
  serviceName: string;
};
