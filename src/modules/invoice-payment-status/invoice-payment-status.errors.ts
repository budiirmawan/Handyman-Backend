import { AppError, ERROR_CODES } from '../../shared/errors';
const error = (code: keyof typeof ERROR_CODES, message: string, statusCode: number) =>
  new AppError({ code: ERROR_CODES[code], message, statusCode });
export const invoicePaymentStatusNotFoundError = (): AppError =>
  error('INVOICE_PAYMENT_STATUS_NOT_FOUND', 'Invoice Payment Status not found.', 404);
export const invoicePaymentStatusInvoiceInvalidError = (): AppError =>
  error('INVOICE_PAYMENT_STATUS_INVOICE_INVALID', 'A finalized or cancelled Tenant Invoice is required.', 400);
export const invoicePaymentStatusAlreadyExistsError = (): AppError =>
  error('INVOICE_PAYMENT_STATUS_ALREADY_EXISTS', 'Payment Status already exists for this Invoice.', 409);
export const invoicePaymentStatusAmountInvalidError = (): AppError =>
  error('INVOICE_PAYMENT_STATUS_AMOUNT_INVALID', 'Paid amount must be non-negative and cannot exceed the authoritative Invoice total.', 400);
export const invoicePaymentStatusPaidAtRequiredError = (): AppError =>
  error('INVOICE_PAYMENT_STATUS_PAID_AT_REQUIRED', 'paidAt is required when paidAmount is greater than zero.', 400);
export const invoicePaymentStatusCancelledError = (): AppError =>
  error('INVOICE_PAYMENT_STATUS_CANCELLED', 'Payment Status for a cancelled Invoice cannot be updated.', 400);
