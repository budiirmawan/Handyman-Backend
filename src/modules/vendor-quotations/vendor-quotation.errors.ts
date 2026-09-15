import { AppError, ERROR_CODES } from '../../shared/errors';

export function vendorQuotationNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_NOT_FOUND, message: 'Vendor quotation not found.', statusCode: 404 });
}
export function vendorQuotationAlreadyExistsError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_ALREADY_EXISTS, message: 'A quotation already exists for this RFQ invitation.', statusCode: 409 });
}
export function vendorQuotationInvitationInvalidError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_INVITATION_INVALID, message: 'The RFQ invitation cannot receive a quotation.', statusCode: 400 });
}
export function vendorQuotationSessionMismatchError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_SESSION_MISMATCH, message: 'The Vendor session is not authorized for this quotation.', statusCode: 404 });
}
export function vendorQuotationRevisionNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_REVISION_NOT_FOUND, message: 'Vendor quotation revision not found.', statusCode: 404 });
}
export function vendorQuotationRevisionNotDraftError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_REVISION_NOT_DRAFT, message: 'Only the current DRAFT quotation revision can be changed.', statusCode: 409 });
}
export function vendorQuotationRevisionAlreadySubmittedError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_REVISION_ALREADY_SUBMITTED, message: 'The submitted quotation revision is immutable.', statusCode: 409 });
}
export function vendorQuotationRevisionIdempotencyConflictError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_REVISION_IDEMPOTENCY_CONFLICT, message: 'The revision idempotency key was already used with a different payload.', statusCode: 409 });
}
export function vendorQuotationIdempotencyKeyRequiredError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_IDEMPOTENCY_KEY_REQUIRED, message: 'An idempotency key is required for this quotation command.', statusCode: 400 });
}
export function vendorQuotationLineNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_LINE_NOT_FOUND, message: 'Vendor quotation line not found.', statusCode: 404 });
}
export function vendorQuotationLineRfqMismatchError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_LINE_RFQ_MISMATCH, message: 'The quotation line must reference a line from the invited RFQ.', statusCode: 400 });
}
export function vendorQuotationLineAlreadyExistsError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_LINE_ALREADY_EXISTS, message: 'This RFQ line is already present in the quotation revision.', statusCode: 409 });
}
export function vendorQuotationIncompleteError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_INCOMPLETE, message: 'Every RFQ line must have one complete quotation response before submission.', statusCode: 400 });
}
export function vendorQuotationCurrencyMismatchError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_CURRENCY_MISMATCH, message: 'Quotation currency must match the RFQ currency.', statusCode: 400 });
}
export function vendorQuotationValidityInvalidError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_VALIDITY_INVALID, message: 'Quotation validity must cover the submission date.', statusCode: 400 });
}
export function vendorQuotationTechnicalComplianceInvalidError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_TECHNICAL_COMPLIANCE_INVALID, message: 'Technical compliance must be explicitly stated; non-compliance requires a deviation.', statusCode: 400 });
}
export function vendorQuotationAttachmentNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_ATTACHMENT_NOT_FOUND, message: 'Quotation attachment not found.', statusCode: 404 });
}
export function vendorQuotationAttachmentInvalidError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_ATTACHMENT_INVALID, message: 'The quotation attachment is invalid for this revision.', statusCode: 400 });
}
export function vendorQuotationAttachmentNumberExistsError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_ATTACHMENT_NUMBER_EXISTS, message: 'A document with this number already exists for the Client.', statusCode: 409 });
}
export function vendorQuotationAttachmentNotAllowedError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_ATTACHMENT_NOT_ALLOWED, message: 'Attachments can only be added to the current DRAFT quotation revision.', statusCode: 409 });
}
export function vendorQuotationDocumentActorUnavailableError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_DOCUMENT_ACTOR_UNAVAILABLE, message: 'The quotation document actor is unavailable.', statusCode: 409 });
}
export function vendorQuotationActionNotAllowedError(): AppError {
  return new AppError({ code: ERROR_CODES.VENDOR_QUOTATION_ACTION_NOT_ALLOWED, message: 'This quotation action is not allowed in the current state.', statusCode: 409 });
}
