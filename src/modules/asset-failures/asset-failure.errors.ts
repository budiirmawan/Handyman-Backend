import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const assetFailureNotFoundError = (): AppError =>
  error(
    ERROR_CODES.ASSET_FAILURE_NOT_FOUND,
    'Asset Failure / Defect not found.',
    404,
  );

/** The Incident exists but is OPERATIONAL / FINDING_ESCALATION. */
export const assetFailureTypeMismatchError = (): AppError =>
  error(
    ERROR_CODES.ASSET_FAILURE_TYPE_MISMATCH,
    'The referenced Incident is not an ASSET_FAILURE Incident.',
    400,
  );

/**
 * The Asset is registered to a different Building than the Incident. Reported
 * as 400 rather than 404: the caller can access both the Building and the
 * Asset, so nothing is disclosed by explaining the mismatch.
 */
export const assetFailureAssetBuildingMismatchError = (): AppError =>
  error(
    ERROR_CODES.ASSET_FAILURE_ASSET_BUILDING_MISMATCH,
    'The referenced Asset does not belong to this Incident building.',
    400,
  );

/**
 * The Asset belongs to a different Client. Deliberately distinct from the
 * Building mismatch: a cross-CLIENT reference is a tenancy-isolation breach,
 * not a data-entry slip, and must be identifiable as such in logs.
 */
export const assetFailureAssetClientMismatchError = (): AppError =>
  error(
    ERROR_CODES.ASSET_FAILURE_ASSET_CLIENT_MISMATCH,
    'The referenced Asset belongs to a different client.',
    400,
  );

/**
 * The Asset carries an authoritative BE-05C Functional Location that
 * contradicts the Incident's own location.
 */
export const assetFailureAssetLocationMismatchError = (
  message = 'The Incident location contradicts the authoritative Asset location.',
): AppError =>
  error(ERROR_CODES.ASSET_FAILURE_ASSET_LOCATION_MISMATCH, message, 400);

/** A RETIRED Asset is out of service and accepts no new failure records. */
export const assetFailureAssetRetiredError = (): AppError =>
  error(
    ERROR_CODES.ASSET_FAILURE_ASSET_RETIRED,
    'A retired Asset cannot receive new failure or defect records.',
    400,
  );

export const assetFailureReporterInvalidError = (): AppError =>
  error(
    ERROR_CODES.ASSET_FAILURE_REPORTER_INVALID,
    'The reporter must be an existing ACTIVE user with access to the Building.',
    400,
  );

export const assetFailureUpdateNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.ASSET_FAILURE_UPDATE_NOT_ALLOWED,
    'A CANCELLED Incident can no longer be updated.',
    400,
  );

export const assetFailureInvalidTransitionError = (
  from: string,
  to: string,
): AppError =>
  error(
    ERROR_CODES.ASSET_FAILURE_INVALID_TRANSITION,
    `Failure status cannot move from ${from} to ${to}.`,
    400,
  );

export const assetFailureOccurrenceInvalidError = (): AppError =>
  error(
    ERROR_CODES.ASSET_FAILURE_OCCURRENCE_INVALID,
    'The occurrence date/time cannot be in the future.',
    400,
  );
