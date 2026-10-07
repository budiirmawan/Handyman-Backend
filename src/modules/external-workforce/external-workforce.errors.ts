import { AppError, ERROR_CODES } from '../../shared/errors';

/** No External Organization reference exists for the given id. */
export function externalOrganizationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXTERNAL_ORGANIZATION_NOT_FOUND,
    message: 'External organization not found.',
    statusCode: 404,
  });
}

/**
 * The External Organization is INACTIVE, so no workforce affiliation may
 * reference it.
 */
export function externalOrganizationInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXTERNAL_ORGANIZATION_INACTIVE,
    message:
      'External organization is inactive and cannot receive workforce affiliations.',
    statusCode: 400,
  });
}

/** No External Workforce Link exists for the addressed pair. */
export function externalWorkforceLinkNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXTERNAL_WORKFORCE_LINK_NOT_FOUND,
    message: 'External workforce affiliation not found.',
    statusCode: 404,
  });
}

/**
 * The Workforce Profile already holds an ACTIVE affiliation with this
 * External Organization. Duplicate active affiliations are rejected rather
 * than silently stacked; the caller updates or deactivates the existing row
 * instead.
 */
export function externalWorkforceAlreadyAffiliatedError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXTERNAL_WORKFORCE_ALREADY_AFFILIATED,
    message:
      'This workforce profile is already actively affiliated with this external organization.',
    statusCode: 409,
  });
}

/**
 * Cross-Client affiliation attempt: the Workforce Profile (via Organization)
 * and the External Organization resolve to different Clients. Reported as 400
 * rather than 404 so the caller learns the combination is invalid without
 * observing another Client's data.
 */
export function externalWorkforceClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXTERNAL_WORKFORCE_CLIENT_MISMATCH,
    message:
      'The workforce profile and the external organization must belong to the same client.',
    statusCode: 400,
  });
}

/**
 * The vendor's personnel code is already in use for this External
 * Organization. Codes stay reserved while any affiliation row (active or
 * historical) references them, mirroring the BE-03C employee-code rule.
 */
export function externalPersonnelCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXTERNAL_PERSONNEL_CODE_ALREADY_EXISTS,
    message:
      'This external personnel code is already in use within the external organization.',
    statusCode: 409,
  });
}

/**
 * Only a Workforce Profile of type EXTERNAL may hold an external workforce
 * affiliation. INTERNAL / OUTSOURCED / CONTRACT profiles are rejected; the
 * affiliation table is reserved for vendor-supplied personnel.
 */
export function workforceNotExternalError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_NOT_EXTERNAL,
    message:
      'Only external workforce profiles can hold external organization affiliations.',
    statusCode: 400,
  });
}
