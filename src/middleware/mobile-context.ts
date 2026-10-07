import type { NextFunction, Request, Response } from 'express';

/**
 * BE-25N — Mobile request context middleware.
 *
 * Captures lightweight mobile device/app metadata from request headers for
 * logging and diagnostics:
 *
 *   X-Device-Id      stable client-generated device identifier
 *   X-Platform       ANDROID | IOS
 *   X-App-Version    running app version (e.g. 1.2.3)
 *
 * Values are validated and length-capped; anything invalid is ignored (the
 * request proceeds — observability must never break the API). The context
 * carries NO sensitive data (never tokens, bodies, or evidence payloads)
 * and is only used for logs/diagnostics, never returned to clients except
 * through the diagnostics endpoint's echo.
 */

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PLATFORM_VALUES = ['ANDROID', 'IOS'];
const APP_VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;

export type MobileRequestContext = {
  deviceId: string | null;
  platform: string | null;
  appVersion: string | null;
};

declare global {
  namespace Express {
    interface Request {
      mobileContext?: MobileRequestContext;
    }
  }
}

function sanitizeHeader(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveMobileContext(req: Request): MobileRequestContext {
  const deviceId = sanitizeHeader(req.header('x-device-id'));
  const platform = sanitizeHeader(req.header('x-platform'))?.toUpperCase() ?? null;
  const appVersion = sanitizeHeader(req.header('x-app-version'));

  return {
    deviceId:
      deviceId && DEVICE_ID_PATTERN.test(deviceId) ? deviceId.slice(0, 128) : null,
    platform: platform && PLATFORM_VALUES.includes(platform) ? platform : null,
    appVersion:
      appVersion && APP_VERSION_PATTERN.test(appVersion)
        ? appVersion.slice(0, 64)
        : null,
  };
}

export function mobileContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  req.mobileContext = resolveMobileContext(req);
  next();
}
