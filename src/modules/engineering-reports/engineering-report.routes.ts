import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  breakdownDatasetHandler,
  checklistDatasetHandler,
  equipmentLogDatasetHandler,
  findingDatasetHandler,
  inspectionDatasetHandler,
  maintenanceDatasetHandler,
  meterReadingDatasetHandler,
  technicalSummaryHandler,
} from './engineering-report.controller';

/**
 * BE-10I — Technical Report Dataset endpoints.
 *
 *   GET /engineering/reports/technical-summary
 *   GET /engineering/reports/inspections
 *   GET /engineering/reports/meter-readings
 *   GET /engineering/reports/equipment-logs
 *   GET /engineering/reports/checklists
 *   GET /engineering/reports/breakdowns
 *   GET /engineering/reports/maintenance
 *   GET /engineering/reports/findings
 *
 * All endpoints require `buildingId` and are read-only reporting
 * projections over the authoritative operational records. No ETL, no
 * warehouse, no chart payloads — reporting-ready rows only.
 */
export function createEngineeringReportRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('engineering_report.read');

  router.get('/engineering/reports/technical-summary', auth, read, technicalSummaryHandler);
  router.get('/engineering/reports/inspections', auth, read, inspectionDatasetHandler);
  router.get('/engineering/reports/meter-readings', auth, read, meterReadingDatasetHandler);
  router.get('/engineering/reports/equipment-logs', auth, read, equipmentLogDatasetHandler);
  router.get('/engineering/reports/checklists', auth, read, checklistDatasetHandler);
  router.get('/engineering/reports/breakdowns', auth, read, breakdownDatasetHandler);
  router.get('/engineering/reports/maintenance', auth, read, maintenanceDatasetHandler);
  router.get('/engineering/reports/findings', auth, read, findingDatasetHandler);

  return router;
}
