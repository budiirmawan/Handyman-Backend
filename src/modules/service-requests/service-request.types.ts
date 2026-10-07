/**
 * BE-17C — Service Request domain types.
 *
 * A Service Request is a procurement / service-demand line item on a Purchase
 * Request (BE-17A). It expresses a demand for an operational service and
 * carries no approval, vendor selection, PO readiness, or operational Work
 * Order execution — those arrive in later BE-17 PARTs (and Work Order
 * execution stays in BE-08).
 *
 * It reuses existing foundations and does NOT duplicate a Vendor or Work Order
 * engine. `client_id` and `building_id` are derived authoritatively from the
 * Purchase Request (never from the caller). `functionalLocationId` is an
 * optional Building-scoped location context; `vendorId` is an optional BE-06
 * Vendor reference (used by later PARTs for vendor selection). `serviceType`
 * is a data-driven code string (no hardcoded model).
 */
export const SERVICE_REQUEST_STATUSES = ['OPEN', 'CANCELLED'] as const;

export type ServiceRequestStatus = (typeof SERVICE_REQUEST_STATUSES)[number];

export function isServiceRequestStatus(
  value: unknown,
): value is ServiceRequestStatus {
  return (
    typeof value === 'string' &&
    (SERVICE_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type ServiceRequestRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  serviceType: string;
  title: string;
  description: string | null;
  requiredDate: Date | null;
  functionalLocationId: string | null;
  vendorId: string | null;
  /**
   * CR-BE-SVC-01 PART 02 — governed Service Catalog anchor. NULLABLE: a NULL
   * anchor means the request relies on its free-text `serviceType` only
   * (historical / un-governed requests). When set, it references a governed
   * `service_catalog` entry in the same Client whose code equals `serviceType`.
   */
  serviceCatalogId: string | null;
  notes: string | null;
  status: ServiceRequestStatus;
  requestedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicServiceRequest = {
  id: string;
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  serviceType: string;
  title: string;
  description: string | null;
  requiredDate: string | null;
  functionalLocationId: string | null;
  vendorId: string | null;
  /** CR-BE-SVC-01 PART 02 — governed anchor (nullable; null = free-text only). */
  serviceCatalogId: string | null;
  notes: string | null;
  status: ServiceRequestStatus;
  requestedByUserId: string;
  createdAt: string;
  updatedAt: string;
  /** Optional resolved context when available. */
  purchaseRequest?: {
    id: string;
    requestNumber: string;
    title: string;
    status: string;
  } | null;
  functionalLocation?: {
    id: string;
    code: string;
    name: string;
    buildingId: string;
  } | null;
};

/** Input supplied by the API consumer when creating a Service Request. */
export type CreateServiceRequestInput = {
  purchaseRequestId: string;
  serviceType: string;
  title: string;
  description?: string;
  requiredDate?: string | null;
  functionalLocationId?: string | null;
  vendorId?: string | null;
  /** CR-BE-SVC-01 PART 02 — optional governed Service Catalog anchor. */
  serviceCatalogId?: string | null;
  notes?: string;
  requestedByUserId: string;
};

/** Fully-resolved Service Request data ready for persistence. */
export type NewServiceRequest = {
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  serviceType: string;
  title: string;
  description: string | null;
  requiredDate: Date | null;
  functionalLocationId: string | null;
  vendorId: string | null;
  serviceCatalogId: string | null;
  notes: string | null;
  requestedByUserId: string;
};

/** Partial update input (PATCH /service-requests/:id). */
export type UpdateServiceRequestInput = {
  serviceType?: string;
  title?: string;
  description?: string | null;
  requiredDate?: string | null;
  functionalLocationId?: string | null;
  vendorId?: string | null;
  /** CR-BE-SVC-01 PART 02 — optional governed anchor change (null clears it). */
  serviceCatalogId?: string | null;
  notes?: string | null;
};

/** List filters for service-request scoped listings. */
export type ServiceRequestFilters = {
  status?: ServiceRequestStatus;
  purchaseRequestId?: string;
  serviceType?: string;
};
