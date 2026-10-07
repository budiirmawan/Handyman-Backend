import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * BE-26B — Notification template errors.
 */
export function notificationTemplateNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_TEMPLATE_NOT_FOUND,
    message: 'Notification template not found.',
    statusCode: 404,
    resource: { type: 'NOTIFICATION_TEMPLATE', id },
  });
}

export function notificationTemplateKeyAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_TEMPLATE_KEY_ALREADY_EXISTS,
    message: 'A notification template with this key already exists.',
    statusCode: 409,
  });
}
