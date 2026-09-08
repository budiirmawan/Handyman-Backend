import { AppError, ERROR_CODES } from '../../shared/errors';

export function vendorCapabilityNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CAPABILITY_NOT_FOUND,
    message: 'Vendor capability not found.',
    statusCode: 404,
  });
}

export function vendorCapabilityCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CAPABILITY_CODE_ALREADY_EXISTS,
    message: 'A capability with this code already exists for this vendor.',
    statusCode: 409,
  });
}

/**
 * The referenced Vendor ↔ Building relationship belongs to a different
 * Vendor. A capability may only be scoped to its own Vendor's relationship.
 */
export function vendorCapabilityRelationshipMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CAPABILITY_RELATIONSHIP_MISMATCH,
    message:
      'The building relationship must belong to the same vendor as the capability.',
    statusCode: 400,
  });
}

/**
 * The referenced Vendor ↔ Building relationship is INACTIVE, so a
 * capability cannot be newly scoped to it.
 */
export function vendorCapabilityRelationshipInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CAPABILITY_RELATIONSHIP_INACTIVE,
    message:
      'An inactive building relationship cannot receive capability scope.',
    statusCode: 400,
  });
}

/**
 * CR-BE-SVC-01 PART 03 — governed Service Catalog identity link. A supplied
 * `service_catalog_id` must resolve, belong to the Vendor's Client, and be
 * ACTIVE for a new/changed assignment. The capability `code` is never
 * rewritten (governance §7).
 */
export function vendorCapabilityCatalogNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CAPABILITY_CATALOG_NOT_FOUND,
    message: 'The referenced service catalog entry was not found.',
    statusCode: 404,
  });
}

export function vendorCapabilityCatalogClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CAPABILITY_CATALOG_CLIENT_MISMATCH,
    message:
      'The service catalog entry does not belong to the vendor\u2019s client.',
    statusCode: 400,
  });
}

export function vendorCapabilityCatalogInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CAPABILITY_CATALOG_INACTIVE,
    message:
      'An inactive service catalog entry cannot be linked to a vendor capability.',
    statusCode: 400,
  });
}
