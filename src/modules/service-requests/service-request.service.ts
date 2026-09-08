import { functionalLocationNotFoundError } from '../functional-locations/functional-location.errors';
import { functionalLocationRepository } from '../functional-locations';
import { vendorNotFoundError } from '../vendors/vendor.errors';
import { vendorRepository } from '../vendors';
import { purchaseRequestRepository } from '../purchase-requests';
import { purchaseRequestNotFoundError } from '../purchase-requests/purchase-request.errors';
import { serviceCatalogRepository } from '../service-catalog';
import {
  serviceRequestCatalogClientMismatchError,
  serviceRequestCatalogCodeMismatchError,
  serviceRequestCatalogInactiveError,
  serviceRequestCatalogNotFoundError,
  serviceRequestLocationBuildingMismatchError,
  serviceRequestNotFoundError,
  serviceRequestNotOpenError,
  serviceRequestPurchaseRequestNotOpenError,
  serviceRequestVendorClientMismatchError,
} from './service-request.errors';
import { serviceRequestRepository } from './service-request.repository';
import type {
  CreateServiceRequestInput,
  NewServiceRequest,
  PublicServiceRequest,
  ServiceRequestFilters,
  ServiceRequestRecord,
  UpdateServiceRequestInput,
} from './service-request.types';

export function toPublicServiceRequest(
  record: ServiceRequestRecord,
): PublicServiceRequest {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    purchaseRequestId: record.purchaseRequestId,
    serviceType: record.serviceType,
    title: record.title,
    description: record.description,
    requiredDate: record.requiredDate ? record.requiredDate.toISOString() : null,
    functionalLocationId: record.functionalLocationId,
    vendorId: record.vendorId,
    serviceCatalogId: record.serviceCatalogId,
    notes: record.notes,
    status: record.status,
    requestedByUserId: record.requestedByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    purchaseRequest: null,
    functionalLocation: null,
  };
}

function toDateOrNull(value: string | null | undefined): Date | null {
  if (value === undefined || value === null) {
    return null;
  }
  return new Date(value);
}

/**
 * CR-BE-SVC-01 PART 02 — validates a governed Service Catalog anchor.
 *
 * When `serviceCatalogId` is supplied, it must (governance §8 / COMPATIBILITY):
 *   1. resolve to an existing catalog entry         → 404 CATALOG_NOT_FOUND
 *   2. belong to the same Client as the request     → 400 CATALOG_CLIENT_MISMATCH
 *   3. be ACTIVE                                     → 400 CATALOG_INACTIVE
 *   4. have a code equal to the request's serviceType → 400 CATALOG_CODE_MISMATCH
 *
 * The free-text `serviceType` is never rewritten. A NULL / absent anchor means
 * the request relies on its free-text `serviceType` only (historical requests).
 * Returns the validated catalog id (or null when the anchor is cleared).
 */
async function resolveServiceCatalogAnchor(
  clientId: string,
  serviceType: string,
  anchorId: string | null,
): Promise<string | null> {
  if (anchorId === null) {
    return null;
  }
  const catalog = await serviceCatalogRepository.findById(undefined, anchorId);
  if (!catalog) {
    throw serviceRequestCatalogNotFoundError();
  }
  if (catalog.clientId !== clientId) {
    throw serviceRequestCatalogClientMismatchError();
  }
  if (catalog.status !== 'ACTIVE') {
    throw serviceRequestCatalogInactiveError();
  }
  if (catalog.code !== serviceType) {
    throw serviceRequestCatalogCodeMismatchError();
  }
  return catalog.id;
}

/**
 * Creates a Service Request line item on a Purchase Request.
 *
 * `client_id` and `building_id` are derived from the Purchase Request (never
 * from the caller). Validation order (pinned by tests):
 *   1. unknown Purchase Request           → 404 PURCHASE_REQUEST_NOT_FOUND
 *   2. Purchase Request not OPEN          → 400 SERVICE_REQUEST_PURCHASE_REQUEST_NOT_OPEN
 *   3. location provided & unknown        → 404 FUNCTIONAL_LOCATION_NOT_FOUND
 *   4. location of a different Building   → 400 SERVICE_REQUEST_LOCATION_BUILDING_MISMATCH
 *   5. vendor provided & unknown          → 404 VENDOR_NOT_FOUND
 *   6. vendor of a different Client       → 400 SERVICE_REQUEST_VENDOR_CLIENT_MISMATCH
 */
export async function createServiceRequest(
  input: CreateServiceRequestInput,
): Promise<PublicServiceRequest> {
  const purchaseRequest = await purchaseRequestRepository.findById(
    input.purchaseRequestId,
  );
  if (!purchaseRequest) {
    throw purchaseRequestNotFoundError();
  }
  if (purchaseRequest.status !== 'OPEN') {
    throw serviceRequestPurchaseRequestNotOpenError();
  }

  let functionalLocationId: string | null = null;
  if (input.functionalLocationId !== undefined && input.functionalLocationId !== null) {
    const location = await functionalLocationRepository.findById(
      input.functionalLocationId,
    );
    if (!location) {
      throw functionalLocationNotFoundError();
    }
    if (location.buildingId !== purchaseRequest.buildingId) {
      throw serviceRequestLocationBuildingMismatchError();
    }
    functionalLocationId = location.id;
  }

  let vendorId: string | null = null;
  if (input.vendorId !== undefined && input.vendorId !== null) {
    const vendor = await vendorRepository.findById(input.vendorId);
    if (!vendor) {
      throw vendorNotFoundError();
    }
    if (vendor.clientId !== purchaseRequest.clientId) {
      throw serviceRequestVendorClientMismatchError();
    }
    vendorId = vendor.id;
  }

  // CR-BE-SVC-01 PART 02 — governed Service Catalog anchor. Same Client as the
  // Purchase Request, ACTIVE, and code equal to the (normalized) serviceType.
  const serviceCatalogId = await resolveServiceCatalogAnchor(
    purchaseRequest.clientId,
    input.serviceType,
    input.serviceCatalogId === undefined ? null : input.serviceCatalogId,
  );

  const newServiceRequest: NewServiceRequest = {
    clientId: purchaseRequest.clientId,
    buildingId: purchaseRequest.buildingId,
    purchaseRequestId: purchaseRequest.id,
    serviceType: input.serviceType,
    title: input.title,
    description: input.description?.trim() || null,
    requiredDate: toDateOrNull(input.requiredDate),
    functionalLocationId,
    vendorId,
    serviceCatalogId,
    notes: input.notes?.trim() || null,
    requestedByUserId: input.requestedByUserId,
  };

  const record = await serviceRequestRepository.create(newServiceRequest);
  return toPublicServiceRequest(record);
}

export async function getServiceRequestById(
  id: string,
): Promise<PublicServiceRequest> {
  const detailed = await serviceRequestRepository.findByIdWithDetails(id);
  if (!detailed) {
    throw serviceRequestNotFoundError();
  }
  return toPublicWithDetails(detailed);
}

export function toPublicWithDetails(
  detailed: Record<string, unknown>,
): PublicServiceRequest {
  const base = toPublicServiceRequest(
    detailed as unknown as ServiceRequestRecord,
  );

  if (detailed.purchaseRequestNumber) {
    base.purchaseRequest = {
      id: detailed.purchaseRequestId as string,
      requestNumber: detailed.purchaseRequestNumber as string,
      title: detailed.purchaseRequestTitle as string,
      status: detailed.purchaseRequestStatus as string,
    };
  }
  if (detailed.locationCode) {
    base.functionalLocation = {
      id: detailed.functionalLocationId as string,
      code: detailed.locationCode as string,
      name: detailed.locationName as string,
      buildingId: (detailed.locationBuildingId as string) ?? (detailed.buildingId as string),
    };
  }
  return base;
}

/**
 * Lists Service Requests for one Building, optionally filtered by status,
 * purchase request, and service type. Queries stay scoped to `building_id`, so
 * the list can never leak another Building's or Client's requests.
 */
export async function listServiceRequestsByBuilding(
  buildingId: string,
  filters: ServiceRequestFilters,
): Promise<PublicServiceRequest[]> {
  const records = await serviceRequestRepository.listByBuilding(buildingId, filters);
  return records.map(toPublicServiceRequest);
}

/**
 * Lists Service Requests of one Purchase Request, optionally filtered by
 * status and service type. The Purchase Request is validated first (unknown PR
 * → 404). Queries stay scoped to the Purchase Request's Building.
 */
export async function listServiceRequestsByPurchaseRequest(
  purchaseRequestId: string,
  filters: ServiceRequestFilters,
): Promise<PublicServiceRequest[]> {
  const purchaseRequest = await purchaseRequestRepository.findById(
    purchaseRequestId,
  );
  if (!purchaseRequest) {
    throw purchaseRequestNotFoundError();
  }

  const records = await serviceRequestRepository.listByPurchaseRequest(
    purchaseRequestId,
    filters,
  );
  return records.map(toPublicServiceRequest);
}

/**
 * Partially updates an OPEN Service Request. `client_id`, `building_id`, and
 * `purchase_request_id` are immutable. A request that is no longer OPEN
 * (CANCELLED) is terminal for intake and cannot be edited.
 */
export async function updateServiceRequest(
  id: string,
  input: UpdateServiceRequestInput,
): Promise<PublicServiceRequest> {
  const existing = await serviceRequestRepository.findById(id);
  if (!existing) {
    throw serviceRequestNotFoundError();
  }
  if (existing.status !== 'OPEN') {
    throw serviceRequestNotOpenError();
  }

  // If updating the location, it must stay within the same Building.
  let functionalLocationId = existing.functionalLocationId;
  if (input.functionalLocationId !== undefined) {
    if (input.functionalLocationId === null) {
      functionalLocationId = null;
    } else {
      const location = await functionalLocationRepository.findById(
        input.functionalLocationId,
      );
      if (!location) {
        throw functionalLocationNotFoundError();
      }
      if (location.buildingId !== existing.buildingId) {
        throw serviceRequestLocationBuildingMismatchError();
      }
      functionalLocationId = location.id;
    }
  }

  // If updating the vendor, it must stay within the same Client.
  let vendorId = existing.vendorId;
  if (input.vendorId !== undefined) {
    if (input.vendorId === null) {
      vendorId = null;
    } else {
      const vendor = await vendorRepository.findById(input.vendorId);
      if (!vendor) {
        throw vendorNotFoundError();
      }
      if (vendor.clientId !== existing.clientId) {
        throw serviceRequestVendorClientMismatchError();
      }
      vendorId = vendor.id;
    }
  }

  // CR-BE-SVC-01 PART 02 — governed Service Catalog anchor. Consistency is
  // enforced only when service_catalog_id is supplied (governance §8): the
  // catalog must be same-Client + ACTIVE + code equal to the effective
  // serviceType (the new one if serviceType is also being changed, else the
  // existing one). A supplied null clears the anchor. The free-text
  // serviceType is never rewritten.
  let serviceCatalogId = existing.serviceCatalogId;
  if (input.serviceCatalogId !== undefined) {
    const effectiveServiceType =
      input.serviceType !== undefined ? input.serviceType : existing.serviceType;
    serviceCatalogId = await resolveServiceCatalogAnchor(
      existing.clientId,
      effectiveServiceType,
      input.serviceCatalogId,
    );
  }

  const record = await serviceRequestRepository.update(id, {
    ...(input.serviceType === undefined ? {} : { serviceType: input.serviceType }),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.requiredDate === undefined ? {} : { requiredDate: input.requiredDate }),
    ...(input.functionalLocationId === undefined
      ? {}
      : { functionalLocationId }),
    ...(input.vendorId === undefined ? {} : { vendorId }),
    ...(input.serviceCatalogId === undefined ? {} : { serviceCatalogId }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  });

  return toPublicServiceRequest(record as ServiceRequestRecord);
}

/**
 * Cancels an OPEN Service Request (OPEN → CANCELLED). An already-cancelled
 * request cannot be cancelled again. Cancel is not a delete — the request
 * remains persisted for history.
 */
export async function cancelServiceRequest(
  id: string,
): Promise<PublicServiceRequest> {
  const existing = await serviceRequestRepository.findById(id);
  if (!existing) {
    throw serviceRequestNotFoundError();
  }
  if (existing.status !== 'OPEN') {
    throw serviceRequestNotOpenError();
  }

  const record = await serviceRequestRepository.updateStatus(id, 'CANCELLED');
  return toPublicServiceRequest(record as ServiceRequestRecord);
}

export const serviceRequestService = {
  cancelServiceRequest,
  createServiceRequest,
  getServiceRequestById,
  listServiceRequestsByBuilding,
  listServiceRequestsByPurchaseRequest,
  toPublicServiceRequest,
  toPublicWithDetails,
  updateServiceRequest,
};
