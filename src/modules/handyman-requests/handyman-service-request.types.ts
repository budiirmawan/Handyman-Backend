/**
 * CR-HM-02 PART 03 — Handyman request intake types (frozen D3).
 *
 * Sibling Handyman-owned request entity (`handyman_service_requests`,
 * migration 0378). It is NOT the tenant-service-request entity: FM
 * OPEN/CANCELLED/CONVERTED semantics are never reused as Handyman business
 * lifecycle authority, and no FM conversion workflow exists.
 *
 * Every request derives its authoritative context from an EXISTING
 * immutable CR-HM-01 channel attribution (the attribution id is the
 * provenance handle; the attribution row is never mutated). Callers never
 * supply clientId/tenantCompanyId/tenantPicId/buildingId/spaceId/
 * originChannel independently — any such fields in input are ignored.
 */

export const HANDYMAN_SERVICE_REQUEST_STATUSES = ['INTAKE'] as const;
export type HandymanServiceRequestStatus =
  (typeof HANDYMAN_SERVICE_REQUEST_STATUSES)[number];

export function isHandymanServiceRequestStatus(
  value: unknown,
): value is HandymanServiceRequestStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_SERVICE_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type HandymanServiceRequestRecord = {
  id: string;
  /** Tenant-isolation root snapshotted from the attribution. */
  clientId: string;
  /** Immutable CR-HM-01 provenance handle. */
  channelAttributionId: string;
  tenantCompanyId: string;
  /** Preserved exactly from the attribution (may be null — never fabricated). */
  tenantPicId: string | null;
  buildingId: string;
  /** Preserved exactly from the attribution when present. */
  spaceId: string | null;
  serviceCatalogId: string;
  serviceVariantId: string | null;
  /** Attribution provenance snapshot (origin channel + durable reference). */
  originChannel: string;
  originReference: string | null;
  description: string | null;
  status: HandymanServiceRequestStatus;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation. */
export type PublicHandymanServiceRequest = Omit<
  HandymanServiceRequestRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

/**
 * Server-side intake input: attribution handle + catalogue selection +
 * free description ONLY. Authoritative context is always derived.
 */
export type CreateHandymanServiceRequestInput = {
  channelAttributionId: string;
  serviceCatalogId: string;
  serviceVariantId?: string;
  description?: string;
};

/** Fully-resolved data ready for persistence (attribution snapshot). */
export type NewHandymanServiceRequest = {
  clientId: string;
  channelAttributionId: string;
  tenantCompanyId: string;
  tenantPicId: string | null;
  buildingId: string;
  spaceId: string | null;
  serviceCatalogId: string;
  serviceVariantId: string | null;
  originChannel: string;
  originReference: string | null;
  description: string | null;
  createdByUserId: string | null;
};
