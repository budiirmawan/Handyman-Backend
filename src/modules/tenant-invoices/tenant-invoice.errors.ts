import { AppError, ERROR_CODES } from '../../shared/errors';
const error = (code: keyof typeof ERROR_CODES, message: string, statusCode: number) =>
  new AppError({ code: ERROR_CODES[code], message, statusCode });
export const tenantInvoiceNotFoundError = (): AppError =>
  error('TENANT_INVOICE_NOT_FOUND', 'Tenant Invoice not found.', 404);
export const tenantInvoiceNumberExistsError = (): AppError =>
  error('TENANT_INVOICE_NUMBER_ALREADY_EXISTS', 'Invoice number already exists for this Client.', 409);
export const tenantInvoiceContextInvalidError = (): AppError =>
  error('TENANT_INVOICE_CONTEXT_INVALID', 'An active Tenant, Building, and Space context is required.', 400);
export const tenantInvoiceSourceInvalidError = (): AppError =>
  error('TENANT_INVOICE_SOURCE_INVALID', 'The source charge or bill is missing, ineligible, or does not match the Invoice context.', 400);
export const tenantInvoiceSourceDuplicateError = (): AppError =>
  error('TENANT_INVOICE_SOURCE_ALREADY_INVOICED', 'The source charge or bill is already linked to an Invoice.', 409);
export const tenantInvoiceNotDraftError = (): AppError =>
  error('TENANT_INVOICE_NOT_DRAFT', 'Only a draft Invoice can be updated or receive charge links.', 400);
export const tenantInvoiceNoLinesError = (): AppError =>
  error('TENANT_INVOICE_NO_LINES', 'A draft Invoice must contain at least one eligible charge before finalization.', 400);
export const tenantInvoiceFinalizedProtectedError = (): AppError =>
  error('TENANT_INVOICE_FINALIZED_PROTECTED', 'A finalized Invoice cannot be overwritten.', 400);
export const tenantInvoiceCancelNotAllowedError = (): AppError =>
  error('TENANT_INVOICE_CANCEL_NOT_ALLOWED', 'This Invoice cannot be cancelled.', 400);
export const tenantInvoiceCurrencyRequiredError = (): AppError =>
  error('TENANT_INVOICE_CURRENCY_REQUIRED', 'A governed Invoice header currency is required to create or finalize this Invoice.', 400);
export const tenantInvoiceCurrencyImmutableError = (): AppError =>
  error('TENANT_INVOICE_CURRENCY_IMMUTABLE', 'The currency of an Invoice with an existing governed snapshot is immutable.', 400);
export const tenantInvoiceCurrencyMismatchError = (): AppError =>
  error('TENANT_INVOICE_CURRENCY_MISMATCH', 'An Invoice line or source currency must exactly equal the Invoice header currency.', 400);
export const tenantInvoiceSourceCurrencyUnknownError = (): AppError =>
  error('TENANT_INVOICE_SOURCE_CURRENCY_UNKNOWN', 'An invoice source with an unknown currency cannot be linked; its currency must be governed or equal the Invoice header.', 400);
