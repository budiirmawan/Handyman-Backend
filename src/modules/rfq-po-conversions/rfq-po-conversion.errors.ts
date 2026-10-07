import { AppError, ERROR_CODES } from '../../shared/errors';

function make(code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], message: string, statusCode: number): AppError {
  return new AppError({ code, message, statusCode });
}

export const rfqPoConversionNotFoundError = (): AppError =>
  make(ERROR_CODES.RFQ_PO_CONVERSION_NOT_FOUND, 'RFQ to Purchase Order conversion not found.', 404);
export const rfqPoConversionAlreadyExistsError = (): AppError =>
  make(ERROR_CODES.RFQ_PO_CONVERSION_ALREADY_EXISTS, 'This RFQ award has already been converted to a Purchase Order.', 409);
export const rfqPoConversionIdempotencyKeyRequiredError = (): AppError =>
  make(ERROR_CODES.RFQ_PO_CONVERSION_IDEMPOTENCY_KEY_REQUIRED, 'An idempotency key is required for RFQ to Purchase Order conversion.', 400);
export const rfqPoConversionIdempotencyConflictError = (): AppError =>
  make(ERROR_CODES.RFQ_PO_CONVERSION_IDEMPOTENCY_CONFLICT, 'The conversion idempotency key was already used with a different request.', 409);
export const rfqPoConversionAwardInvalidError = (): AppError =>
  make(ERROR_CODES.RFQ_PO_CONVERSION_AWARD_INVALID, 'Only a finalized Vendor RFQ award can be converted to a Purchase Order.', 409);
export const rfqPoConversionReadinessInvalidError = (): AppError =>
  make(ERROR_CODES.RFQ_PO_CONVERSION_READINESS_INVALID, 'A matching READY Purchase Order Readiness record is required for conversion.', 409);
export const rfqPoConversionLineInvalidError = (): AppError =>
  make(ERROR_CODES.RFQ_PO_CONVERSION_LINE_INVALID, 'The awarded quotation and RFQ lines cannot be mapped deterministically to Purchase Order Lines.', 409);
export const rfqPoConversionScopeInvalidError = (): AppError =>
  make(ERROR_CODES.RFQ_PO_CONVERSION_SCOPE_INVALID, 'RFQ, award, Vendor, readiness, and Purchase Order scope is inconsistent.', 409);
export const rfqPoConversionCurrencyInvalidError = (): AppError =>
  make(ERROR_CODES.RFQ_PO_CONVERSION_CURRENCY_INVALID, 'The awarded quotation currency does not match the RFQ and Purchase Order currency authority.', 409);
