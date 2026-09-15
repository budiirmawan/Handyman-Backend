import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { getMobileDiagnosticsHandler } from './mobile-diagnostics.controller';

/**
 * BE-25N — Mobile observability.
 *
 *   GET /mobile/diagnostics
 *
 * Basic mobile API health/diagnostic metadata (authenticated): correlation
 * id, server time, uptime, and sanitized mobile device/app context. The
 * X-Request-ID header is the mobile request correlation id on every
 * response; device/app version metadata is captured from mobile headers for
 * logs (BE-25N middleware).
 */
export function createMobileDiagnosticsRouter(): Router {
  const router = Router();

  router.get('/mobile/diagnostics', authenticationMiddleware, getMobileDiagnosticsHandler);

  return router;
}
