import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { securityFindingIncidentKpiHandler } from './security-finding-incident-kpi.controller';

/**
 * BE-23F2 — Security Finding / Incident / Handover KPI endpoint.
 *
 *   GET /security/reports/finding-incident-kpi
 *     [?buildingId=...][&securityPostId=...][&patrolRouteId=...]
 *     [&incidentType=OPERATIONAL|ASSET_FAILURE|FINDING_ESCALATION]
 *     [&dateFrom=YYYY-MM-DD][&dateTo=YYYY-MM-DD]
 *
 * Requires authentication plus `security_finding_incident_kpi.read`.
 * Omitting `buildingId` rolls the KPI up across every accessible
 * Building.
 *
 * Read-only: direct queries over the BE-09 Finding, BE-21 Incident, and
 * BE-10J/BE-12G Shift Handover records. No ETL, no warehouse, and no
 * mutation of source domain state. Patrol KPI is BE-23F1 and is not
 * served here.
 */
export function createSecurityFindingIncidentKpiRouter(): Router {
  const router = Router();

  router.get(
    '/security/reports/finding-incident-kpi',
    authenticationMiddleware,
    requirePermission('security_finding_incident_kpi.read'),
    securityFindingIncidentKpiHandler,
  );

  return router;
}
