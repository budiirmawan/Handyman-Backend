import { AppError, ERROR_CODES } from '../../shared/errors';

export function rfqNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_NOT_FOUND,
    message: 'RFQ not found.',
    statusCode: 404,
  });
}

export function rfqNumberAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_NUMBER_ALREADY_EXISTS,
    message: 'An RFQ with this number already exists for this client.',
    statusCode: 409,
  });
}

export function rfqIdempotencyKeyRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_IDEMPOTENCY_KEY_REQUIRED,
    message: 'An idempotency key is required to create an RFQ.',
    statusCode: 400,
  });
}

export function rfqIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_IDEMPOTENCY_CONFLICT,
    message: 'The idempotency key was already used with a different RFQ request.',
    statusCode: 409,
  });
}

export function rfqPurchaseRequestInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_PURCHASE_REQUEST_INVALID,
    message: 'The referenced Purchase Request is invalid or cancelled.',
    statusCode: 400,
  });
}

export function rfqPurchaseRequestNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_PURCHASE_REQUEST_NOT_FOUND,
    message: 'The referenced Purchase Request was not found.',
    statusCode: 404,
  });
}

export function rfqContextMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_CONTEXT_MISMATCH,
    message: 'The RFQ context does not match the referenced Purchase Request.',
    statusCode: 400,
  });
}

export function rfqNotDraftError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_NOT_DRAFT,
    message: 'Only DRAFT RFQs can be changed.',
    statusCode: 400,
  });
}

export function rfqNotOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_NOT_OPEN,
    message: 'Only OPEN RFQs can be closed.',
    statusCode: 400,
  });
}

export function rfqInvalidTransitionError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_INVALID_TRANSITION,
    message: 'The RFQ lifecycle transition is not allowed.',
    statusCode: 409,
  });
}

export function rfqNoLinesError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_NO_LINES,
    message: 'An RFQ must contain at least one demand line before it can be opened.',
    statusCode: 400,
  });
}

export function rfqDeadlineRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_RESPONSE_DEADLINE_REQUIRED,
    message: 'A response deadline is required before opening an RFQ.',
    statusCode: 400,
  });
}

export function rfqDeadlineInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_RESPONSE_DEADLINE_INVALID,
    message: 'The response deadline must be in the future.',
    statusCode: 400,
  });
}

export function rfqLineNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_LINE_NOT_FOUND,
    message: 'RFQ line not found.',
    statusCode: 404,
  });
}

export function rfqLineSourceInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_LINE_SOURCE_INVALID,
    message: 'The referenced demand line is invalid, cancelled, or belongs to another request.',
    statusCode: 400,
  });
}

export function rfqLineSourceModeMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_LINE_SOURCE_MODE_MISMATCH,
    message: 'The demand line type does not match the RFQ source mode.',
    statusCode: 400,
  });
}

export function rfqLineAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_LINE_ALREADY_EXISTS,
    message: 'This demand line is already linked to an RFQ.',
    statusCode: 409,
  });
}

export function rfqLineNotApprovedError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_LINE_NOT_APPROVED,
    message: 'All Material Request lines must be APPROVED before opening a material RFQ.',
    statusCode: 400,
  });
}

export function rfqSourceChangedError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_SOURCE_CHANGED,
    message: 'The referenced demand source changed after the RFQ snapshot was created.',
    statusCode: 409,
  });
}
