/**
 * CR-BE-SAAS-01 PART 10B — Tenant health + commercial dashboard routes
 * (frozen §21.1 / §21.2 / §22).
 *
 * Frozen routes:
 *   GET /api/v1/platform/tenant-health               (platform.health.read)
 *     query: customerId? (optional — when omitted, the per-customer
 *     projection is still single-customer-scoped; PART 10A service
 *     requires customerId)
 *   GET /api/v1/platform/reports/commercial-summary  (platform.reporting.read)
 *
 * No `/me/*` health route is frozen in §22.1; this module does NOT
 * introduce one.
 */
import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import {
  getTenantHealthHandler,
  getCommercialSummaryHandler,
} from './platform-health.controller';

const auth = authenticationMiddleware;

export function createPlatformHealthRouter(): Router {
  const router = Router();
  router.get(
    '/platform/tenant-health',
    auth,
    requirePlatformPermission('platform.health.read'),
    getTenantHealthHandler,
  );
  router.get(
    '/platform/reports/commercial-summary',
    auth,
    requirePlatformPermission('platform.reporting.read'),
    getCommercialSummaryHandler,
  );
  return router;
}
