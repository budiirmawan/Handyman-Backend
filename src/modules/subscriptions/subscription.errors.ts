import { AppError, ERROR_CODES } from '../../shared/errors';

export function subscriptionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SUBSCRIPTION_NOT_FOUND,
    message: 'Subscription not found.',
    statusCode: 404,
  });
}

export function subscriptionCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SUBSCRIPTION_CODE_ALREADY_EXISTS,
    message: 'A subscription with this code already exists.',
    statusCode: 409,
  });
}

export function subscriptionNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SUBSCRIPTION_NOT_ACTIVE,
    message: 'Only ACTIVE subscriptions are commercially usable.',
    statusCode: 400,
  });
}
