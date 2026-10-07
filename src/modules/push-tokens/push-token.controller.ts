import type { NextFunction, Request, Response } from 'express';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { isValidUuid } from '../clients';
import { pushTokenService } from './push-token.service';
import type { RegisterPushTokenInput } from './push-token.types';

/**
 * BE-25L — Push token registration handlers.
 *
 *   POST   /mobile/push-tokens                 register / rotate
 *   GET    /mobile/push-tokens                 list my registrations
 *   DELETE /mobile/push-tokens/:tokenId        deactivate / unregister
 *
 * The token always belongs to the AUTHENTICATED user (user_id is taken from
 * the session, never from the body).
 */

const param = (value: string | string[]): string =>
  Array.isArray(value) ? '' : value;

export async function registerPushTokenHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};
    const input: RegisterPushTokenInput = {
      deviceId: body.deviceId,
      pushToken: body.pushToken,
      platform: body.platform,
      appVersion: body.appVersion,
      deviceModel: body.deviceModel,
      deviceOsVersion: body.deviceOsVersion,
    };
    const registration = await pushTokenService.registerPushToken(
      req.auth.userId,
      input,
    );
    sendSuccess(res, registration, 201);
  } catch (error) {
    next(error);
  }
}

export async function listPushTokensHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(res, await pushTokenService.listPushTokens(req.auth.userId));
  } catch (error) {
    next(error);
  }
}

export async function deactivatePushTokenHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tokenId = param(req.params.tokenId);
    if (!isValidUuid(tokenId)) {
      throw AppError.validation('Request validation failed.', [
        { field: 'tokenId', message: 'tokenId must be a valid UUID.' },
      ]);
    }
    const deactivated = await pushTokenService.deactivatePushToken(
      req.auth.userId,
      tokenId,
    );
    if (!deactivated) {
      throw new AppError({
        code: ERROR_CODES.NOT_FOUND,
        message: 'Active push token registration not found.',
        statusCode: 404,
        resource: { type: 'PUSH_TOKEN', id: tokenId },
      });
    }
    sendSuccess(res, deactivated);
  } catch (error) {
    next(error);
  }
}
