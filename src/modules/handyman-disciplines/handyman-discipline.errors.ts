import { AppError, ERROR_CODES } from '../../shared/errors';

/** Referenced discipline does not exist or is not ACTIVE (F9 authority). */
export function handymanDisciplineInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DISCIPLINE_INVALID,
    message: 'The referenced Handyman discipline does not exist or is not ACTIVE.',
    statusCode: 400,
  });
}

/** A catalogue entry can be associated with exactly one discipline. */
export function handymanDisciplineAssociationConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DISCIPLINE_ASSOCIATION_CONFLICT,
    message: 'This service catalogue entry is already associated with a discipline.',
    statusCode: 409,
  });
}
