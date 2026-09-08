import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * BE-26H — Notification reminder errors.
 */
export function notificationReminderNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_REMINDER_NOT_FOUND,
    message: 'Notification reminder not found.',
    statusCode: 404,
    resource: { type: 'NOTIFICATION_REMINDER', id },
  });
}

export function notificationReminderKeyAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_REMINDER_KEY_ALREADY_EXISTS,
    message: 'A notification reminder with this key already exists.',
    statusCode: 409,
  });
}

/** The referenced BE-26B template does not exist (create/update validation). */
export function notificationReminderTemplateMissingError(): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_REMINDER_TEMPLATE_NOT_FOUND,
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

/** The reminder is not PENDING, so the transition is not allowed. */
export function notificationReminderNotPendingError(): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_REMINDER_NOT_PENDING,
    message: 'The reminder is not PENDING.',
    statusCode: 409,
  });
}
