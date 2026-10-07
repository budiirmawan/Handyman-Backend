import { AppError, ERROR_CODES } from '../../shared/errors';
const error = (code: keyof typeof ERROR_CODES, message: string, statusCode: number) =>
  new AppError({ code: ERROR_CODES[code], message, statusCode });
export const utilityExceptionNotFoundError = () =>
  error('UTILITY_EXCEPTION_NOT_FOUND', 'Utility operational exception not found.', 404);
export const utilityExceptionReferenceInvalidError = (message = 'Utility exception references do not share one authoritative Client, Building, and utility type.') =>
  error('UTILITY_EXCEPTION_REFERENCE_INVALID', message, 400);
export const utilityExceptionDuplicateError = () =>
  error('UTILITY_EXCEPTION_ALREADY_OPEN', 'An active Utility exception already exists for this source and exception type.', 409);
export const utilityExceptionTransitionError = () =>
  error('UTILITY_EXCEPTION_TRANSITION_INVALID', 'The Utility exception lifecycle transition is not allowed.', 409);
