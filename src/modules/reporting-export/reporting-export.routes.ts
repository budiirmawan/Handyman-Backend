import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { reportingExportHandler } from './reporting-export.controller';

/**
 * BE-23J — Export Dataset endpoint.
 *
 *   GET /reports/export?dataset=SECURITY_PATROL|SECURITY_FINDING_INCIDENT|
 *                               WORKFORCE|VENDOR_TENANT|UTILITY|
 *                               MANAGEMENT_OPERATIONS_COMMAND_CENTER
 *     [plus every filter the selected dataset's owning endpoint accepts]
 *
 * Requires authentication plus `reporting_export.read`. Management datasets
 * additionally require `management_read_model.read`. Building access is
 * asserted inside the owning BE-23 KPI or BE-24 read-model service, so there
 * is no second access path here.
 *
 * Returns an export-ready JSON envelope: period / filter metadata, flat
 * KPI values, row/column structured tables and a generated timestamp.
 * No KPI is recalculated, no chart is rendered, no PDF or Excel file is
 * produced, and nothing is materialised.
 */
export function createReportingExportRouter(): Router {
  const router = Router();

  router.get(
    '/reports/export',
    authenticationMiddleware,
    requirePermission('reporting_export.read'),
    reportingExportHandler,
  );

  return router;
}
