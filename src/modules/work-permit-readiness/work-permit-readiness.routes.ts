import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createWorkPermitReadinessHandler,
  getWorkPermitReadinessHandler,
  listWorkPermitReadinessHandler,
  resolveVendorWorkPermitReadinessHandler,
  updateWorkPermitReadinessHandler,
} from './work-permit-readiness.controller';

/**
 * BE-15D — Work Permit Readiness endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation (enforced in the service/controller after resolving the
 * readiness's / vendor work's Building).
 *
 * Management (`vendor.manage`):
 *   POST  /permit-readiness
 *   PATCH /permit-readiness/:readinessId
 * Reads (`vendor.read`):
 *   GET   /permit-readiness                    (?vendorWorkId= & ?vendorId= & ?buildingId=)
 *   GET   /permit-readiness/current            (?vendorWorkId=)
 *   GET   /permit-readiness/:readinessId
 *
 * This is a readiness/binding layer only — no Permit-to-Work engine.
 */
export function createWorkPermitReadinessRouter(): Router {
  const router = Router();

  router.post(
    '/permit-readiness',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    createWorkPermitReadinessHandler,
  );
  router.get(
    '/permit-readiness',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listWorkPermitReadinessHandler,
  );
  router.get(
    '/permit-readiness/current',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    resolveVendorWorkPermitReadinessHandler,
  );
  router.get(
    '/permit-readiness/:readinessId',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getWorkPermitReadinessHandler,
  );
  router.patch(
    '/permit-readiness/:readinessId',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateWorkPermitReadinessHandler,
  );

  return router;
}
