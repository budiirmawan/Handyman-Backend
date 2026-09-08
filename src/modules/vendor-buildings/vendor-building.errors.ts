import { AppError, ERROR_CODES } from '../../shared/errors';

/** No Vendor Building Relationship exists for the addressed pair. */
export function vendorBuildingRelationshipNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_BUILDING_RELATIONSHIP_NOT_FOUND,
    message: 'Vendor building relationship not found.',
    statusCode: 404,
  });
}

/**
 * The Vendor already serves this Building on an ACTIVE relationship.
 * Duplicate active relationships are rejected rather than silently stacked;
 * the caller updates or deactivates the existing row instead.
 */
export function vendorBuildingAlreadyRelatedError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_BUILDING_ALREADY_RELATED,
    message: 'This vendor already has an active relationship with this building.',
    statusCode: 409,
  });
}

/**
 * Cross-Client relationship attempt: the Vendor and the Building (via
 * Property) resolve to different Clients. Reported as 400 rather than 404 so
 * the caller learns the combination is invalid without observing another
 * Client's data.
 */
export function vendorBuildingClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_BUILDING_CLIENT_MISMATCH,
    message: 'The vendor and the building must belong to the same client.',
    statusCode: 400,
  });
}

/**
 * The Building is INACTIVE, so no Vendor can be newly related to it.
 * Distinct from BE-02F's `BUILDING_NOT_AVAILABLE`, which is about a User's
 * access grant.
 */
export function vendorBuildingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_BUILDING_INACTIVE,
    message: 'Building is inactive and cannot receive vendor relationships.',
    statusCode: 400,
  });
}
