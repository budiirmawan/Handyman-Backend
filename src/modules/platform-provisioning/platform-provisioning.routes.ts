/**
 * CR-BE-SAAS-01 PART 05 — Provisioning HTTP routes (frozen §22).
 *
 * Two required routes plus the optional run lookup (for console surfaces).
 * All routes live under `/api/v1/platform/...` and are guarded by the
 * canonical `requirePlatformPermission` middleware.
 */
import { Router, type RequestHandler } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import {
  getProvisioningRunHandler,
  getProvisioningSummaryHandler,
  listProvisioningRunsHandler,
  provisionCustomerHandler,
} from './platform-provisioning.controller';

export function createPlatformProvisioningRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  // POST /platform/customers/:customerId/provision
  router.post(
    '/platform/customers/:customerId/provision',
    auth,
    requirePlatformPermission('platform.provisioning.execute') as RequestHandler,
    provisionCustomerHandler as RequestHandler,
  );

  // GET /platform/customers/:customerId/provisioning (summary)
  router.get(
    '/platform/customers/:customerId/provisioning',
    auth,
    requirePlatformPermission('platform.customer.read') as RequestHandler,
    getProvisioningSummaryHandler as RequestHandler,
  );

  // GET /platform/customers/:customerId/provisioning/runs (history)
  router.get(
    '/platform/customers/:customerId/provisioning/runs',
    auth,
    requirePlatformPermission('platform.customer.read') as RequestHandler,
    listProvisioningRunsHandler as RequestHandler,
  );

  // GET /platform/provisioning/runs/:runId (console)
  router.get(
    '/platform/provisioning/runs/:runId',
    auth,
    requirePlatformPermission('platform.customer.read') as RequestHandler,
    getProvisioningRunHandler as RequestHandler,
  );

  return router;
}
