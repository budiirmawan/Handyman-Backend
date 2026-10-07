import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createServiceReportHandler,
  finalizeServiceReportHandler,
  getServiceReportHandler,
  listServiceReportsHandler,
  updateServiceReportHandler,
} from './vendor-service-report.controller';

/**
 * BE-15G — Vendor Service Report endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation (enforced in the service/controller after resolving the
 * report's / vendor work's Building).
 *
 * Management (`vendor.manage`):
 *   POST  /vendor-service-reports
 *   PATCH /vendor-service-reports/:reportId          (update DRAFT)
 *   POST  /vendor-service-reports/:reportId/finalize
 * Reads (`vendor.read`):
 *   GET   /vendor-service-reports                    (?vendorWorkId= & ?vendorId= & ?buildingId=)
 *   GET   /vendor-service-reports/:reportId
 *
 * This is a reporting layer — no BAST Binding endpoints here.
 */
export function createVendorServiceReportRouter(): Router {
  const router = Router();

  router.post(
    '/vendor-service-reports',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    createServiceReportHandler,
  );
  router.get(
    '/vendor-service-reports',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listServiceReportsHandler,
  );
  router.get(
    '/vendor-service-reports/:reportId',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getServiceReportHandler,
  );
  router.patch(
    '/vendor-service-reports/:reportId',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateServiceReportHandler,
  );
  router.post(
    '/vendor-service-reports/:reportId/finalize',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    finalizeServiceReportHandler,
  );

  return router;
}
