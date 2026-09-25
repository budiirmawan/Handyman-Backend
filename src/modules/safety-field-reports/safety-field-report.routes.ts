import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createSafetyFieldReportHandler,
  getSafetyFieldReportHandler,
} from './safety-field-report.controller';

/**
 * CR-BE-RN18-SAFETY-FIELD-REPORT-01 — Hazard / Near-Miss Field Reporting.
 *
 * Dedicated thin field-reporting surface:
 *   POST /safety/field-reports
 *   GET /safety/field-reports/:incidentId
 *
 * RBAC:
 *   POST requires safety_field_report.create
 *   GET requires safety_field_report.read
 * Both require Building access (asserted in the service layer).
 */
export function createSafetyFieldReportRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const createPerm = requirePermission('safety_field_report.create');
  const readPerm = requirePermission('safety_field_report.read');

  router.post(
    '/safety/field-reports',
    auth,
    createPerm,
    createSafetyFieldReportHandler,
  );
  router.get(
    '/safety/field-reports/:incidentId',
    auth,
    readPerm,
    getSafetyFieldReportHandler,
  );

  return router;
}
