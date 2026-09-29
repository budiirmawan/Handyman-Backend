import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-09 PART 01 — persistence-boundary errors ONLY. No command,
 * lifecycle, approval, or financial errors exist at this boundary
 * (no commands exist in this PART).
 */
export function handymanMaterialExecutionLineNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_EXECUTION_LINE_NOT_FOUND,
    message: 'Handyman material execution line not found.',
    statusCode: 404,
  });
}

/* ---- PART 03 command errors (ESTIMATE + LINK + APPROVE) --------- */

/** Only the CURRENT authoritative assigned Crew Lead may act. */
export function handymanMaterialExecutionNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_EXECUTION_NOT_AUTHORIZED,
    message:
      'Only the current authoritative assigned Crew Lead may act on Handyman material execution.',
    statusCode: 403,
  });
}

/** ESTIMATE requires an AUTHORIZED execution scope. */
export function handymanMaterialExecutionScopeNotEligibleError()
  : AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_EXECUTION_SCOPE_NOT_ELIGIBLE,
    message:
      'Handyman execution scope is not authorized for material execution.',
    statusCode: 409,
  });
}

/**
 * Quotation link invalid: the linked version is not the scope's
 * APPROVED quotation snapshot, or the line is not a MATERIAL line on
 * that version. The link is an authority anchor — never a guess.
 */
export function handymanMaterialExecutionLinkInvalidError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID,
    message: 'Invalid Handyman material execution quotation link.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

/** estimatedQty must be > 0 and <= the approved quotation snapshot quantity. */
export function handymanMaterialExecutionEstimateInvalidError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_EXECUTION_ESTIMATE_INVALID,
    message: 'Invalid Handyman material execution estimate quantity.',
    statusCode: 400,
    details: [`reason=${reason}`],
  });
}

/**
 * Acquisition quantity caps: the issued/purchased axis may never
 * exceed the approved quotation quantity authority (governance D4).
 */
export function handymanMaterialExecutionQuantityExceededError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED,
    message:
      'Handyman material execution quantity exceeds the approved authority.',
    statusCode: 400,
    details: [`reason=${reason}`],
  });
}

/** One execution line per quotation line (one-link-per-quotation-line). */
export function handymanMaterialExecutionLinkConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_EXECUTION_LINK_CONFLICT,
    message:
      'A Handyman material execution line already exists for this quotation line.',
    statusCode: 409,
  });
}

/** Frozen lifecycle violation (ESTIMATE -> APPROVE only here). */
export function handymanMaterialExecutionIllegalTransitionError(
  from: string,
  action: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_EXECUTION_ILLEGAL_TRANSITION,
    message:
      'Illegal Handyman material execution transition (frozen lifecycle).',
    statusCode: 409,
    details: [`from=${from}`, `action=${action}`],
  });
}

/** Bounded request-surface validation (no authority from caller). */
export function handymanMaterialExecutionValidationError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.VALIDATION_ERROR,
    message: `Invalid Handyman material execution request (${field}).`,
    statusCode: 400,
    details: [`field=${field}`],
  });
}
