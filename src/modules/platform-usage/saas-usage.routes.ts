/**
 * CR-BE-SAAS-01 PART 09 — Usage routes (frozen §22).
 *
 * Two routers:
 *   1. `createPlatformUsageRouter()` mounted under `/api/v1/platform`
 *      and prefixes for /usage, /usage/meters, /usage/records,
 *      /customers/:id/usage.
 *   2. `createMeUsageRouter()` mounted under `/api/v1/me` for the
 *      caller-scoped `GET /me/usage` route.
 *
 * Both routers attach authentication + `requirePlatformPermission`
 * per-route (the platform permission namespace is asserted at
 * registration so business-plane roles cannot acquire it — D2).
 */
import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import {
  createSaasUsageMeterHandler,
  getCustomerUsageProjectionHandler,
  getMeUsageHandler,
  listSaasUsageHandler,
  listSaasUsageMetersHandler,
  recordSaasUsageHandler,
} from './saas-usage.controller';

const auth = authenticationMiddleware;

export function createPlatformUsageRouter(): Router {
  const router = Router();

  // GET /platform/usage/meters — read usage meter catalog.
  router.get(
    '/platform/usage/meters',
    auth,
    requirePlatformPermission('platform.usage.read'),
    listSaasUsageMetersHandler,
  );

  // POST /platform/usage/meters — define a new meter (§22 PART 09).
  router.post(
    '/platform/usage/meters',
    auth,
    requirePlatformPermission('platform.billing.manage'),
    createSaasUsageMeterHandler,
  );

  // GET /platform/usage — list usage records with filters.
  router.get(
    '/platform/usage',
    auth,
    requirePlatformPermission('platform.usage.read'),
    listSaasUsageHandler,
  );

  // POST /platform/usage/records — trusted-producer append (Idem.).
  router.post(
    '/platform/usage/records',
    auth,
    requirePlatformPermission('platform.billing.manage'),
    recordSaasUsageHandler,
  );

  // GET /platform/customers/:id/usage — per-customer quota projection
  // (frozen §12.3 last bullet).
  router.get(
    '/platform/customers/:id/usage',
    auth,
    requirePlatformPermission('platform.usage.read'),
    getCustomerUsageProjectionHandler,
  );

  return router;
}

export function createMeUsageRouter(): Router {
  const router = Router();

  // GET /me/usage — quota projection per accessible customer (§22).
  // Permission model is `platform.usage.read` (same scope as the
  // platform route), per frozen §22 row 956.
  router.get(
    '/me/usage',
    auth,
    requirePlatformPermission('platform.usage.read'),
    getMeUsageHandler,
  );

  return router;
}
