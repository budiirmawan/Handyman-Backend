import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';

/**
 * BE-25N — Mobile diagnostics handler.
 *
 *   GET /mobile/diagnostics
 *
 * Basic mobile API health/diagnostic metadata: correlation id (requestId),
 * server time, process uptime, and the sanitized mobile context echoed from
 * the request headers (device id / platform / app version — only when the
 * client sent them). Lightweight by design — no monitoring platform, no
 * counters beyond what the response itself carries.
 */

const startedAt = Date.now();

export async function getMobileDiagnosticsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const context = req.mobileContext;
    sendSuccess(res, {
      status: 'OK',
      requestId: req.requestId,
      serverTime: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      ...(context && (context.deviceId || context.platform || context.appVersion)
        ? {
            device: {
              ...(context.deviceId ? { deviceId: context.deviceId } : {}),
              ...(context.platform ? { platform: context.platform } : {}),
              ...(context.appVersion ? { appVersion: context.appVersion } : {}),
            },
          }
        : {}),
    });
  } catch (error) {
    next(error);
  }
}
