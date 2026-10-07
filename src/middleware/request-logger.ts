import type { NextFunction, Request, Response } from 'express';
import { logger } from '../shared/logger';

/**
 * BE-25N — Request logger with mobile context.
 *
 * Every completed request is logged with its correlation id (requestId).
 * When the caller is a mobile client (BE-25N mobile context headers), the
 * device/app version metadata is included in the log line — never token
 * values, bodies, or evidence payloads.
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    logger.info('HTTP request completed', {
      requestId: req.requestId,
      method: req.method,
      path: requestPath(req),
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs),
      ...mobileLogFields(req),
    });
  });

  next();
}

/** BE-25N — mobile device/app metadata for logs (null-safe, sanitized). */
export function mobileLogFields(req: Request): Record<string, string | undefined> {
  const context = req.mobileContext;
  if (!context) {
    return {};
  }
  return {
    ...(context.deviceId ? { mobileDeviceId: context.deviceId } : {}),
    ...(context.platform ? { mobilePlatform: context.platform } : {}),
    ...(context.appVersion ? { mobileAppVersion: context.appVersion } : {}),
  };
}

export function requestPath(req: Request): string {
  const [path] = req.originalUrl.split('?');
  return path || req.path;
}
