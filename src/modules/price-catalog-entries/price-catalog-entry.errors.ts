import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-BE-PRICE-01 PART 01 — Price Authority errors.
 *
 * Errors are structured and stable; 409-class errors mark conflicts that are
 * safe to retry with a corrected request (overlap, lifecycle, idempotency).
 */

export function priceCatalogEntryNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_ENTRY_NOT_FOUND,
    message: 'Price catalog entry not found.',
    statusCode: 404,
  });
}

export function priceCatalogIdempotencyKeyRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_IDEMPOTENCY_KEY_REQUIRED,
    message: 'An idempotency key is required for this price catalog command.',
    statusCode: 400,
  });
}

export function priceCatalogIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_IDEMPOTENCY_CONFLICT,
    message:
      'The idempotency key was already used with a different price catalog request.',
    statusCode: 409,
  });
}

export function priceCatalogClientInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_CLIENT_INVALID,
    message: 'The referenced Client was not found or is not active.',
    statusCode: 404,
  });
}

export function priceCatalogItemNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_ITEM_NOT_FOUND,
    message: 'The referenced Inventory Item was not found.',
    statusCode: 404,
  });
}

export function priceCatalogItemInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_ITEM_INVALID,
    message:
      'The Inventory Item does not belong to the governed Client or is not active.',
    statusCode: 400,
  });
}

export function priceCatalogUomNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_UOM_NOT_FOUND,
    message: 'The referenced Unit of Measure was not found.',
    statusCode: 404,
  });
}

export function priceCatalogUomInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_UOM_INVALID,
    message:
      'The Unit of Measure does not belong to the governed Client or is not active.',
    statusCode: 400,
  });
}

export function priceCatalogVendorNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_VENDOR_NOT_FOUND,
    message: 'The referenced Vendor was not found.',
    statusCode: 404,
  });
}

export function priceCatalogVendorInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_VENDOR_INVALID,
    message:
      'The Vendor does not belong to the governed Client or is not active.',
    statusCode: 400,
  });
}

export function priceCatalogBuildingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_BUILDING_NOT_FOUND,
    message: 'The referenced Building was not found.',
    statusCode: 404,
  });
}

export function priceCatalogBuildingInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_BUILDING_INVALID,
    message:
      'The Building does not belong to the governed Client or is not active.',
    statusCode: 400,
  });
}

export function priceCatalogApproverInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_APPROVER_INVALID,
    message: 'The approver must reference an existing active User.',
    statusCode: 400,
  });
}

export function priceCatalogEffectiveWindowInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_EFFECTIVE_WINDOW_INVALID,
    message:
      'The effective window is invalid: effective_to must be empty or later than effective_from, and a replacement window must not start before the predecessor window.',
    statusCode: 400,
  });
}

export function priceCatalogWindowOverlapError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_WINDOW_OVERLAP,
    message:
      'An active price already exists for this exact item, UOM, currency, and scope tier with an overlapping effective window.',
    statusCode: 409,
  });
}

export function priceCatalogNotDraftError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_NOT_DRAFT,
    message: 'Only a DRAFT price catalog entry allows this command.',
    statusCode: 409,
  });
}

export function priceCatalogNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_NOT_ACTIVE,
    message: 'Only an ACTIVE price catalog entry allows this command.',
    statusCode: 409,
  });
}

export function priceCatalogAlreadyReplacedError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_ALREADY_REPLACED,
    message: 'This price catalog entry has already been replaced.',
    statusCode: 409,
  });
}

/**
 * PART 02 defensive fail-closed surface: the resolver observing more than
 * one applicable ACTIVE price in a single scope tier means the structural
 * uniqueness guarantee was compromised. This is an integrity incident, an
 * error for the caller — never a silently picked price (governance §8/§17).
 */
export function priceCatalogLookupAmbiguousError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRICE_CATALOG_LOOKUP_AMBIGUOUS,
    message:
      'The price lookup failed closed: more than one applicable ACTIVE price survived scope precedence. No price was selected; the incident was recorded for investigation.',
    statusCode: 409,
  });
}
