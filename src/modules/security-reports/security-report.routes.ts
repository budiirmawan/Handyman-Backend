import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  incidentReadinessDatasetHandler,
  keyControlDatasetHandler,
  lostFoundDatasetHandler,
  patrolDatasetHandler,
  securityFindingDatasetHandler,
  securityPostDatasetHandler,
  securitySummaryHandler,
  shiftHandoverDatasetHandler,
  visitorBindingDatasetHandler,
} from './security-report.controller';

/**
 * BE-12M — Security Reporting Dataset endpoints.
 *
 *   GET /security/reports/summary
 *   GET /security/reports/patrols
 *   GET /security/reports/security-posts
 *   GET /security/reports/findings
 *   GET /security/reports/shift-handovers
 *   GET /security/reports/incident-readiness
 *   GET /security/reports/visitor-bindings
 *   GET /security/reports/keys
 *   GET /security/reports/lost-found
 *
 * All endpoints require `security_report.read` plus authentication.
 * The summary endpoint optionally rolls up across every accessible
 * building; the dataset endpoints all require `buildingId`. Every
 * query is a direct read over the BE-12 authoritative source
 * records. No ETL, no warehouse, no chart payloads.
 */
export function createSecurityReportRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('security_report.read');

  router.get('/security/reports/summary', auth, read, securitySummaryHandler);
  router.get('/security/reports/patrols', auth, read, patrolDatasetHandler);
  router.get(
    '/security/reports/security-posts',
    auth,
    read,
    securityPostDatasetHandler,
  );
  router.get(
    '/security/reports/findings',
    auth,
    read,
    securityFindingDatasetHandler,
  );
  router.get(
    '/security/reports/shift-handovers',
    auth,
    read,
    shiftHandoverDatasetHandler,
  );
  router.get(
    '/security/reports/incident-readiness',
    auth,
    read,
    incidentReadinessDatasetHandler,
  );
  router.get(
    '/security/reports/visitor-bindings',
    auth,
    read,
    visitorBindingDatasetHandler,
  );
  router.get('/security/reports/keys', auth, read, keyControlDatasetHandler);
  router.get(
    '/security/reports/lost-found',
    auth,
    read,
    lostFoundDatasetHandler,
  );

  return router;
}
