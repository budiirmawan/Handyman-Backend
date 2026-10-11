import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * W03 PART 03C — the uniform refusal of the PIC credential surface.
 *
 * ONE shape for every rejection reason (forged signature, unknown key, bad
 * window, replayed assertion, inactive integration, missing capability,
 * unresolvable representation, expired or revoked session, foreign tenant):
 * `HANDYMAN_PIC_WORKSPACE_UNAUTHORIZED`, 401, no reason detail. Each distinct
 * message would be an enumeration oracle over who exists in which tenant, and
 * the care workspace already established the shape (`care-workspace.service.ts`
 * `workspaceUnauthorized`) — the codes are additive (A01 §10 C15), nothing else
 * in the error vocabulary moves (MC3).
 *
 * T9 is the other half of this file: only the explicit rejections below are
 * collapses. An infrastructure failure (pool, driver, unknown constraint)
 * propagates untouched so it surfaces as a 5xx and can never be read as
 * "authorized" or quietly retried as "not authorized".
 */
export function picWorkspaceUnauthorized(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PIC_WORKSPACE_UNAUTHORIZED,
    message: 'PIC workspace authentication failed.',
    statusCode: 401,
  });
}

/**
 * A 404 with the identical shape for every "this credential cannot see that
 * resource" answer, so a read surface cannot be used to probe ids (the same
 * non-enumerating rule 03B2 applied to ineligible PICs). Owned by the bounded
 * PIC read surface (`03D`); defined here so 03D does not invent a second shape.
 */
export function picWorkspaceResourceNotFound(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PIC_WORKSPACE_RESOURCE_NOT_FOUND,
    message: 'Resource not found for this PIC session.',
    statusCode: 404,
  });
}

/** Admission and logout accept no context fields (rule 8; care precedent). */
export function picWorkspaceRejectsContextError(): AppError {
  return AppError.validation('Query and body context fields are not accepted.');
}
