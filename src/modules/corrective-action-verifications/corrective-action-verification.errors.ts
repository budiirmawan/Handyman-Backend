import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const correctiveActionVerificationNotFoundError = (): AppError =>
  error(
    ERROR_CODES.CORRECTIVE_ACTION_VERIFICATION_NOT_FOUND,
    'This Corrective Action has no open verification.',
    404,
  );

/**
 * The Corrective Action exists but is not in a verifiable state — there is
 * nothing to confirm until completion is claimed, and nothing left to confirm
 * once the action is verified, rejected, or cancelled.
 */
export const correctiveActionNotReviewableError = (
  message = 'This Corrective Action is not in a reviewable state.',
): AppError =>
  error(
    ERROR_CODES.CORRECTIVE_ACTION_VERIFICATION_NOT_REVIEWABLE,
    message,
    400,
  );

export const correctiveActionVerificationAlreadyOpenError = (): AppError =>
  error(
    ERROR_CODES.CORRECTIVE_ACTION_VERIFICATION_ALREADY_OPEN,
    'This Corrective Action already has an open verification.',
    409,
  );

/**
 * A recorded decision is final. 409 rather than 400: the request is
 * well-formed, but it conflicts with a decision already on record.
 */
export const correctiveActionVerificationImmutableError = (
  message = 'A completed verification cannot be overwritten.',
): AppError =>
  error(
    ERROR_CODES.CORRECTIVE_ACTION_VERIFICATION_IMMUTABLE,
    message,
    409,
  );

/** Only the reviewer the verification was opened for may decide it. */
export const correctiveActionVerificationReviewerMismatchError = (): AppError =>
  error(
    ERROR_CODES.CORRECTIVE_ACTION_VERIFICATION_REVIEWER_MISMATCH,
    'Only the assigned reviewer may submit this verification.',
    403,
  );

/**
 * Independence rule: whoever completed the work cannot be the one who
 * confirms it. Without this, "verification" would be the doer marking their
 * own homework and the COMPLETED/VERIFIED distinction would carry no
 * assurance at all.
 */
export const correctiveActionVerificationSelfReviewError = (): AppError =>
  error(
    ERROR_CODES.CORRECTIVE_ACTION_VERIFICATION_SELF_REVIEW,
    'The person who completed a Corrective Action cannot verify it.',
    403,
  );
