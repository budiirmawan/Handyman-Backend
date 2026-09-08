import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createCompletionReportHandler,
  getCompletionReportHandler,
  listCompletionReportsHandler,
  submitCompletionReportHandler,
  updateCompletionReportHandler,
} from './vendor-completion-report.controller';

/**
 * BE-15F — Vendor Completion Report endpoints, protected by BE-01 RBAC and
 * BE-02 Building isolation (enforced in the service/controller after resolving
 * the report's / vendor work's Building).
 *
 * Management (`vendor.manage`):
 *   POST  /vendor-completion-reports
 *   PATCH /vendor-completion-reports/:reportId          (update DRAFT)
 *   POST  /vendor-completion-reports/:reportId/submit   (finalize)
 * Reads (`vendor.read`):
 *   GET   /vendor-completion-reports                    (?vendorWorkId= & ?vendorId= & ?buildingId=)
 *   GET   /vendor-completion-reports/:reportId
 *
 * This is a reporting layer — the BE-08 Work Order completion lifecycle
 * remains BE-08's authority. No Service Report endpoints here.
 */
export function createVendorCompletionReportRouter(): Router {
  const router = Router();

  router.post(
    '/vendor-completion-reports',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    createCompletionReportHandler,
  );
  router.get(
    '/vendor-completion-reports',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listCompletionReportsHandler,
  );
  router.get(
    '/vendor-completion-reports/:reportId',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getCompletionReportHandler,
  );
  router.patch(
    '/vendor-completion-reports/:reportId',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateCompletionReportHandler,
  );
  router.post(
    '/vendor-completion-reports/:reportId/submit',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    submitCompletionReportHandler,
  );

  return router;
}
