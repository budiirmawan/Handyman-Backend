import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * BE-26F — Email delivery errors.
 */
export function emailRecipientNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.EMAIL_RECIPIENT_NOT_FOUND,
    message: 'Email recipient not found or has no usable email address.',
    statusCode: 404,
  });
}

export function emailDeliveryNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.EMAIL_DELIVERY_NOT_FOUND,
    message: 'Email delivery not found.',
    statusCode: 404,
    resource: { type: 'EMAIL_DELIVERY', id },
  });
}
