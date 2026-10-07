import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * BE-26G — WhatsApp delivery errors.
 */
export function whatsappRecipientNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WHATSAPP_RECIPIENT_NOT_FOUND,
    message: 'WhatsApp recipient not found or is not an active user.',
    statusCode: 404,
  });
}

export function whatsappDeliveryNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.WHATSAPP_DELIVERY_NOT_FOUND,
    message: 'WhatsApp delivery not found.',
    statusCode: 404,
    resource: { type: 'WHATSAPP_DELIVERY', id },
  });
}
