import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-BM-CARE-AUTH-01 — Building Customer Care authority errors.
 *
 * Single non-enumerating denial: a missing Care permission, a missing or
 * revoked Building assignment, an INACTIVE Building, a wrong asserted
 * Client/Company, a non-ACTIVE account and a cross-tenant attempt ALL
 * collapse into `HANDYMAN_CARE_AUTHORITY_DENIED` with one message.
 *
 * Collapsing is deliberate. Distinct codes would let a caller distinguish
 * "this Building exists but is not mine" from "this Building does not exist",
 * which is a Building/Client enumeration oracle across tenants.
 */
export function careAuthorityDeniedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CARE_AUTHORITY_DENIED,
    message:
      'Building Customer Care authority is not available for this building.',
    statusCode: 403,
  });
}

/**
 * A browser-supplied recording identity was presented. The Backend never
 * trusts it and never silently ignores it — it rejects, so no client can
 * believe the value was honoured (SD-19).
 */
export function careIdentityNotAcceptedError(field: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CARE_IDENTITY_NOT_ACCEPTED,
    message: `Recording identity is derived from the authenticated session only; '${field}' is not accepted.`,
    statusCode: 400,
    details: [{ field, reason: 'session_derived_only' }],
  });
}
