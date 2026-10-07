import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { resolveMobileQrHandler } from './mobile-qr.controller';

/**
 * BE-25F — Mobile QR Resolution Contract.
 *
 *   GET /mobile/qr/resolve/:identifier
 *
 * Mobile QR/identifier resolution: resolves an opaque identifier through the
 * existing BE-05H Asset Identifier authority and returns the target with
 * Building / Functional-Location context, Asset / Equipment context where
 * applicable, and available mobile action hints. Access is restricted to the
 * BE-02G accessible set — an inaccessible value yields the same 404 as an
 * unknown one (existence is hidden, matching the existing resolve endpoint).
 * No separate QR engine.
 */
export function createMobileQrResolutionRouter(): Router {
  const router = Router();

  router.get(
    '/mobile/qr/resolve/:identifier',
    authenticationMiddleware,
    requirePermission('asset_identifier.read'),
    resolveMobileQrHandler,
  );

  return router;
}
