import { AppError, ERROR_CODES } from '../../shared/errors';

export function serviceRequestNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REQUEST_NOT_FOUND,
    message: 'Service request not found.',
    statusCode: 404,
  });
}

/** Service Requests can only be added to an OPEN Purchase Request. */
export function serviceRequestPurchaseRequestNotOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REQUEST_PURCHASE_REQUEST_NOT_OPEN,
    message: 'Service requests can only be added to an open purchase request.',
    statusCode: 400,
  });
}

/**
 * The referenced Functional Location does not belong to the same Building as
 * the Purchase Request.
 */
export function serviceRequestLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REQUEST_LOCATION_BUILDING_MISMATCH,
    message: 'The functional location does not belong to the purchase request\u2019s building.',
    statusCode: 400,
  });
}

/** The referenced Vendor does not belong to the Purchase Request's Client. */
export function serviceRequestVendorClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REQUEST_VENDOR_CLIENT_MISMATCH,
    message: 'The vendor does not belong to the purchase request\u2019s client.',
    statusCode: 400,
  });
}

/**
 * Only OPEN Service Requests are mutable at intake. A request that is no
 * longer OPEN (already CANCELLED) cannot have its details changed, and an
 * already-cancelled request cannot be cancelled again.
 */
export function serviceRequestNotOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REQUEST_NOT_OPEN,
    message: 'Only open service requests can be modified.',
    statusCode: 400,
  });
}

/**
 * CR-BE-SVC-01 PART 02 — governed Service Catalog anchor validation. A
 * supplied `service_catalog_id` must resolve, belong to the same Client as
 * the request, be ACTIVE, and have a code equal to the request's
 * `service_type`. The free-text `service_type` is never rewritten.
 */
export function serviceRequestCatalogNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REQUEST_CATALOG_NOT_FOUND,
    message: 'The referenced service catalog entry was not found.',
    statusCode: 404,
  });
}

export function serviceRequestCatalogClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REQUEST_CATALOG_CLIENT_MISMATCH,
    message: 'The service catalog entry does not belong to the request\u2019s client.',
    statusCode: 400,
  });
}

export function serviceRequestCatalogInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REQUEST_CATALOG_INACTIVE,
    message: 'An inactive service catalog entry cannot be assigned to a service request.',
    statusCode: 400,
  });
}

export function serviceRequestCatalogCodeMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REQUEST_CATALOG_CODE_MISMATCH,
    message: 'The service catalog entry code must match the request\u2019s service type.',
    statusCode: 400,
  });
}
