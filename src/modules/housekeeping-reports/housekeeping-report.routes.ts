import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cleaningDatasetHandler,
  complaintDatasetHandler,
  consumableDatasetHandler,
  findingDatasetHandler,
  housekeepingSummaryHandler,
  inspectionDatasetHandler,
  qualityAuditDatasetHandler,
  supervisorInspectionDatasetHandler,
} from './housekeeping-report.controller';

/**
 * BE-11M — Housekeeping Report Dataset endpoints.
 *
 *   GET /housekeeping/reports/summary
 *   GET /housekeeping/reports/cleaning
 *   GET /housekeeping/reports/inspections
 *   GET /housekeeping/reports/supervisor-inspections
 *   GET /housekeeping/reports/findings
 *   GET /housekeeping/reports/consumables
 *   GET /housekeeping/reports/quality-audits
 *   GET /housekeeping/reports/complaints
 */
export function createHousekeepingReportRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('housekeeping_report.read');

  router.get(
    '/housekeeping/reports/summary',
    auth,
    read,
    housekeepingSummaryHandler,
  );
  router.get(
    '/housekeeping/reports/cleaning',
    auth,
    read,
    cleaningDatasetHandler,
  );
  router.get(
    '/housekeeping/reports/inspections',
    auth,
    read,
    inspectionDatasetHandler,
  );
  router.get(
    '/housekeeping/reports/supervisor-inspections',
    auth,
    read,
    supervisorInspectionDatasetHandler,
  );
  router.get(
    '/housekeeping/reports/findings',
    auth,
    read,
    findingDatasetHandler,
  );
  router.get(
    '/housekeeping/reports/consumables',
    auth,
    read,
    consumableDatasetHandler,
  );
  router.get(
    '/housekeeping/reports/quality-audits',
    auth,
    read,
    qualityAuditDatasetHandler,
  );
  router.get(
    '/housekeeping/reports/complaints',
    auth,
    read,
    complaintDatasetHandler,
  );

  return router;
}
