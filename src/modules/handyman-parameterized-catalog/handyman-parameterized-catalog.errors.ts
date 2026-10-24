import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — parameterized catalogue errors.
 *
 * 404 = the addressed governed row does not exist (or is invisible to the
 * caller, so no existence leak); 409 = a governed identity conflict; 400 =
 * the caller's facts are not admissible.
 *
 * Client/Building isolation denials reuse the shared
 * `buildingAccessDeniedError` from the context-access module — this module
 * never invents a second access rule.
 */

export function handymanServiceCategoryNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_CATEGORY_NOT_FOUND,
    message: 'Handyman service category not found.',
    statusCode: 404,
  });
}

export function handymanServiceCategoryAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_CATEGORY_ALREADY_EXISTS,
    message:
      'A Handyman service category with this code already exists for this client.',
    statusCode: 409,
  });
}

export function handymanServiceAttributeNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_ATTRIBUTE_NOT_FOUND,
    message: 'Handyman service attribute not found.',
    statusCode: 404,
  });
}

export function handymanServiceAttributeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_ATTRIBUTE_ALREADY_EXISTS,
    message:
      'A Handyman service attribute with this code already exists for this service.',
    statusCode: 409,
  });
}

export function handymanServiceAttributeInvalidError(
  message = 'Handyman service attribute validation failed.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_ATTRIBUTE_INVALID,
    message,
    statusCode: 400,
  });
}

export function handymanServiceCommercialProfileNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_COMMERCIAL_PROFILE_NOT_FOUND,
    message: 'Handyman service commercial profile not found.',
    statusCode: 404,
  });
}

export function handymanServicePriceRuleNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_PRICE_RULE_NOT_FOUND,
    message: 'Handyman service price rule not found.',
    statusCode: 404,
  });
}

export function handymanServicePriceRuleAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_PRICE_RULE_ALREADY_EXISTS,
    message:
      'A Handyman service price rule with this ruleCode already exists for this client.',
    statusCode: 409,
  });
}

export function handymanServicePriceRuleInvalidError(
  message = 'Handyman service price rule validation failed.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_PRICE_RULE_INVALID,
    message,
    statusCode: 400,
  });
}

export function handymanServiceRequestItemNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_ITEM_NOT_FOUND,
    message: 'Handyman service request item not found.',
    statusCode: 404,
  });
}

export function handymanServiceRequestItemInvalidError(
  message = 'Handyman service request item validation failed.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_ITEM_INVALID,
    message,
    statusCode: 400,
  });
}

export function handymanServiceQuoteResolutionInvalidError(
  message = 'Handyman service quote resolution validation failed.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_QUOTE_RESOLUTION_INVALID,
    message,
    statusCode: 400,
  });
}

export function handymanServiceCatalogImportInvalidError(
  message = 'Handyman service catalog starter import validation failed.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_CATALOG_IMPORT_INVALID,
    message,
    statusCode: 400,
  });
}

/* ------------------------------------------------------------------ */
/* CR-HM-SERVICE-CATALOG-01 PART 02 — variant attributes              */
/* ------------------------------------------------------------------ */

export function handymanServiceVariantNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VARIANT_NOT_FOUND,
    message: 'Handyman service variant not found.',
    statusCode: 404,
  });
}

export function handymanServiceVariantAttributeNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VARIANT_ATTRIBUTE_NOT_FOUND,
    message: 'Handyman service variant attribute not found.',
    statusCode: 404,
  });
}

export function handymanServiceVariantAttributeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VARIANT_ATTRIBUTE_ALREADY_EXISTS,
    message:
      'This variant already carries a choice for that attribute; edit or retire the existing choice instead.',
    statusCode: 409,
  });
}

export function handymanServiceVariantAttributeInvalidError(
  message = 'Handyman service variant attribute validation failed.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VARIANT_ATTRIBUTE_INVALID,
    message,
    statusCode: 400,
  });
}

export function handymanServicePriceRuleCollisionError(
  message = 'Handyman service price rule collides with an existing rule.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_PRICE_RULE_COLLISION,
    message,
    statusCode: 409,
  });
}
