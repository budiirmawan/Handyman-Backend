import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createLicenseHandler,
  getLicenseEffectiveStateHandler,
  getLicenseHandler,
  listLicensesHandler,
  updateLicenseStatusHandler,
} from './license.controller';

/**
 * License management endpoints, protected by RBAC.
 *
 * Reads (`license.read`): GET /licenses/:id,
 *   GET /licenses/:id/effective, GET /subscriptions/:subscriptionId/licenses.
 * Management (`license.manage`): POST /subscriptions/:subscriptionId/licenses,
 *   PATCH /licenses/:id/status.
 */
export function createLicenseRouter(): Router {
  const router = Router();

  router.post(
    '/subscriptions/:subscriptionId/licenses',
    authenticationMiddleware,
    requirePermission('license.manage'),
    createLicenseHandler,
  );
  router.get(
    '/subscriptions/:subscriptionId/licenses',
    authenticationMiddleware,
    requirePermission('license.read'),
    listLicensesHandler,
  );
  router.get(
    '/licenses/:id',
    authenticationMiddleware,
    requirePermission('license.read'),
    getLicenseHandler,
  );
  router.get(
    '/licenses/:id/effective',
    authenticationMiddleware,
    requirePermission('license.read'),
    getLicenseEffectiveStateHandler,
  );
  router.patch(
    '/licenses/:id/status',
    authenticationMiddleware,
    requirePermission('license.manage'),
    updateLicenseStatusHandler,
  );

  return router;
}
