import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-BE-RN20-PERMIT-FIELD-01 — the ONE new denial of the field surface.
 *
 * Raised when the authenticated caller is not an authorized field actor of the
 * Permit Work: no ACTIVE `permit_workers` → ACTIVE `vendor_workforce_bindings`
 * → ACTIVE `workforce_profiles` (`user_id` = caller) chain exists for the
 * permit's application, or the Permit itself is CANCELLED. Every other denial
 * on this surface is an EXISTING error (`PERMIT_WORK_CONTEXT_INVALID`,
 * `BUILDING_ACCESS_DENIED`, `PERMIT_WORK_NOT_READY`,
 * `PERMIT_WORK_ACTION_NOT_ALLOWED`, `PERMIT_WORK_ALREADY_*`,
 * `PERMIT_WORK_CLOSE_BEFORE_START`, `PERMISSION_DENIED`).
 */
export const permitWorkFieldUnauthorizedError = (): AppError =>
  new AppError({
    code: ERROR_CODES.PERMIT_WORK_FIELD_UNAUTHORIZED,
    message: 'Caller is not an authorized field actor for this Permit Work.',
    statusCode: 403,
  });
