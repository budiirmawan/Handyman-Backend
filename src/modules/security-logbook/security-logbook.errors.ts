import { AppError, ERROR_CODES } from '../../shared/errors';

/** The logbook entry could not be located. */
export function securityLogbookEntryNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_LOGBOOK_ENTRY_NOT_FOUND,
    message: 'Security logbook entry not found.',
    statusCode: 404,
  });
}

/** Only OPEN entries can be updated; CLOSED is terminal. */
export function securityLogbookEntryImmutableError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_LOGBOOK_ENTRY_IMMUTABLE,
    message: 'Closed security logbook entries cannot be modified.',
    statusCode: 400,
  });
}

/** The referenced Shift Handover belongs to a different Building. */
export function securityLogbookHandoverBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_LOGBOOK_HANDOVER_BUILDING_MISMATCH,
    message:
      'The shift handover does not belong to the logbook entry\u2019s Building.',
    statusCode: 400,
  });
}
