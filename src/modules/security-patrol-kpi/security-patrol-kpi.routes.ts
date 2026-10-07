import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { securityPatrolKpiHandler } from './security-patrol-kpi.controller';

/**
 * BE-23F1 — Security Patrol & Activity KPI endpoint.
 *
 *   GET /security/reports/patrol-kpi
 *     [?buildingId=...][&securityPostId=...][&patrolRouteId=...]
 *     [&dateFrom=YYYY-MM-DD][&dateTo=YYYY-MM-DD][&graceMinutes=N]
 *
 * Requires authentication plus `security_patrol_kpi.read`. Omitting
 * `buildingId` rolls the KPI up across every accessible Building.
 *
 * Read-only: a direct query over the BE-12 Security records and the
 * BE-07 schedule store. No ETL, no warehouse, no chart payloads, and
 * no mutation of Security domain state.
 */
export function createSecurityPatrolKpiRouter(): Router {
  const router = Router();

  router.get(
    '/security/reports/patrol-kpi',
    authenticationMiddleware,
    requirePermission('security_patrol_kpi.read'),
    securityPatrolKpiHandler,
  );

  return router;
}
