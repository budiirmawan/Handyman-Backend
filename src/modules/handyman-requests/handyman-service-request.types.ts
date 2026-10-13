import type { HandymanCareActorType } from '../handyman-care-actors/handyman-care-actor.types';

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

/**
 * FROZEN F1 bounded vocabulary (CR-HM-03 PART 01): INTAKE creation state
 * plus the exact triage-chain states. READY_FOR_NEXT_STEP / REFERRED are
 * FROZEN F1 but arrive with the decision chain (PART 03/04) — adding them
 * earlier would be a dead state. No execution/quotation/provider state is
 * ever part of this vocabulary.
 */
export const HANDYMAN_SERVICE_REQUEST_STATUSES = [
  'INTAKE',
  'TRIAGE',
  'INSPECTION_REQUIRED',
  'DIAGNOSIS',
  'READY_FOR_NEXT_STEP',
  'REFERRED',
] as const;
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
 * CR-HM-17 GAP PART 01 — Backend-resolved attribution / care-actor
 * provenance composed from the immutable `handyman_channel_attributions`
 * row bound to the request.
 */
export type HandymanRequestAttributionProvenance = {
  id: string;
  originChannel: string;
  originReference: string | null;
  createdByUserId: string | null;
  actorType: HandymanCareActorType | null;
  careActorId: string | null;
  actorReference: string | null;
  createdAt: string;
};

/**
 * Database projection record for Customer Care request reads.
 * Includes governed request/status, Backend-resolved attribution /
 * care-actor provenance, and execution-scope pointer where present.
 */
export type HandymanCustomerCareServiceRequestRecord =
  HandymanServiceRequestRecord & {
    actorType: HandymanCareActorType | null;
    careActorId: string | null;
    actorReference: string | null;
    attributionCreatedAt: Date;
    executionScopeId: string | null;
  };

/**
 * Safe public Customer Care read projection (list + detail).
 * Includes only governed request/status, Backend-resolved
 * attribution/care-actor provenance, and execution-scope pointer
 * where present. No local status inference; no FM/SaaS fallback.
 */
export type PublicHandymanCustomerCareServiceRequest =
  PublicHandymanServiceRequest & {
    actorType: HandymanCareActorType | null;
    careActorId: string | null;
    actorReference: string | null;
    attribution: HandymanRequestAttributionProvenance;
    executionScopeId: string | null;
  };

/**
 * Client-scoped filter input for `listHandymanServiceRequests`.
 */
export type HandymanServiceRequestListFilters = {
  clientId: string;
  tenantCompanyId?: string;
  buildingId?: string;
  spaceId?: string;
  channelAttributionId?: string;
  status?: HandymanServiceRequestStatus;
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
