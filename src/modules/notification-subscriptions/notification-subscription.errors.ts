import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * BE-26D — Notification event subscription errors.
 */
export function notificationSubscriptionNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_SUBSCRIPTION_NOT_FOUND,
    message: 'Notification event subscription not found.',
    statusCode: 404,
    resource: { type: 'NOTIFICATION_SUBSCRIPTION', id },
  });
}

export function notificationSubscriptionKeyAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_SUBSCRIPTION_KEY_ALREADY_EXISTS,
    message: 'A notification event subscription with this key already exists.',
    statusCode: 409,
  });
}

/** The referenced BE-26B template does not exist (create/update validation). */
export function notificationSubscriptionTemplateMissingError(): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_SUBSCRIPTION_TEMPLATE_NOT_FOUND,
    message: 'Referenced notification template not found.',
    statusCode: 400,
    details: [
      {
        field: 'templateKey',
        message: 'Referenced notification template does not exist.',
      },
    ],
  });
}
