/**
 * CR-BE-SAAS-01 PART 12B — Platform configuration HTTP routes
 * (frozen §22).
 *
 * Frozen routes (exactly four):
 *
 *   GET    /api/v1/platform/configuration
 *     perm: platform.customer.read
 *   GET    /api/v1/platform/configuration/:key
 *     perm: platform.customer.read
 *   POST   /api/v1/platform/configuration/:key
 *     perm: platform.configuration.manage
 *   PATCH  /api/v1/platform/configuration/:key
 *     perm: platform.configuration.manage
 *
 * No DELETE, no bulk mutation, no free-form unknown keys. D2 holds:
 * PLATFORM_ADMIN without the explicit permission is denied (403).
 * Reads NEVER audit; mutations emit exactly one
 * `SAAS_PLATFORM_CONFIG_CHANGED` (§18.2) inside the same
 * transaction.
 */
import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import {
  createPlatformConfigurationHandler,
  getPlatformConfigurationHandler,
  listPlatformConfigurationHandler,
  updatePlatformConfigurationHandler,
} from './platform-configuration.controller';

const auth = authenticationMiddleware;

export function createPlatformConfigurationRouter(): Router {
  const router = Router();

  router.get(
    '/platform/configuration',
    auth,
    requirePlatformPermission('platform.customer.read'),
    listPlatformConfigurationHandler,
  );
  router.get(
    '/platform/configuration/:key',
    auth,
    requirePlatformPermission('platform.customer.read'),
    getPlatformConfigurationHandler,
  );
  router.post(
    '/platform/configuration/:key',
    auth,
    requirePlatformPermission('platform.configuration.manage'),
    createPlatformConfigurationHandler,
  );
  router.patch(
    '/platform/configuration/:key',
    auth,
    requirePlatformPermission('platform.configuration.manage'),
    updatePlatformConfigurationHandler,
  );

  return router;
}
