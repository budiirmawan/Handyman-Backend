import type { NextFunction, Request, Response } from 'express';
import { getAppConfig } from '../config';
import { sanitizeDatabaseError } from '../database';
import { sendAppError } from '../shared/api-response';
import { AppError } from '../shared/errors';
import { logger } from '../shared/logger';
import { mobileLogFields, requestPath } from './request-logger';

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    return;
  }

  if (error instanceof AppError) {
    const fields = {
      requestId: req.requestId,
      errorName: error.name,
      code: error.code,
      statusCode: error.statusCode,
      path: requestPath(req),
      method: req.method,
      ...mobileLogFields(req),
    };

    if (error.statusCode >= 500) {
      logger.error(error.message, fields);
    } else {
      logger.warn(error.message, fields);
    }

    sendAppError(res, error, { requestId: req.requestId });
    return;
  }

  if (isPayloadTooLargeError(error)) {
    logger.warn('Request payload is too large.', {
      requestId: req.requestId,
      path: requestPath(req),
      method: req.method,
      statusCode: 413,
      code: 'BAD_REQUEST',
    });
    sendAppError(
      res,
      new AppError({
        code: 'BAD_REQUEST',
        message: 'Request payload is too large.',
        statusCode: 413,
      }),
      { requestId: req.requestId },
    );
    return;
  }

  if (isJsonParseError(error)) {
    logger.warn('Invalid JSON request body.', {
      requestId: req.requestId,
      path: requestPath(req),
      method: req.method,
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
    sendAppError(res, AppError.badRequest('Invalid JSON request body.'), {
      requestId: req.requestId,
    });
    return;
  }

  logger.error('Unhandled error', {
    requestId: req.requestId,
    ...mobileLogFields(req),
    errorName: error instanceof Error ? error.name : 'Error',
    errorMessage: sanitizeLogMessage(
      error instanceof Error ? error.message : 'Unknown error',
    ),
    path: requestPath(req),
    method: req.method,
    ...(shouldLogStack() && error instanceof Error && error.stack
      ? { stack: error.stack }
      : {}),
  });

  sendAppError(res, AppError.internal(), { requestId: req.requestId });
}

function isPayloadTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { type?: string; status?: number };
  return candidate.type === 'entity.too.large' || candidate.status === 413;
}

function isJsonParseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { type?: string; status?: number };
  return (
    candidate.type === 'entity.parse.failed' ||
    (error instanceof SyntaxError && candidate.status === 400)
  );
}

function shouldLogStack(): boolean {
  try {
    return !getAppConfig().isProduction;
  } catch {
    return process.env.NODE_ENV !== 'production';
  }
}

function sanitizeLogMessage(message: string): string {
  try {
    return sanitizeDatabaseError(message, getAppConfig().database.password);
  } catch {
    return message;
  }
}
