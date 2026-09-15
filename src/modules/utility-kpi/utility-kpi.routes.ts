import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { utilityKpiHandler } from './utility-kpi.controller';

/**
 * BE-23I — Utility KPI endpoint.
 *
 *   GET /utility/reports/kpi
 *     [?buildingId=...][&utilityType=ELECTRICITY|WATER|GAS]
 *     [&dateFrom=YYYY-MM-DD][&dateTo=YYYY-MM-DD]
 *     [&interval=DAY|MONTH|YEAR][&includeSubMeters=true|false]
 *
 * Requires authentication plus `utility_kpi.read`. Omitting `buildingId`
 * rolls the KPI up across every accessible Building.
 *
 * Read-only. Every consumption / abnormality / verification figure is
 * delegated to BE-18M's aggregation service rather than recomputed, so
 * this endpoint can never disagree with the Utility domain. No ETL, no
 * warehouse, and no mutation of Utility state.
 */
export function createUtilityKpiRouter(): Router {
  const router = Router();

  router.get(
    '/utility/reports/kpi',
    authenticationMiddleware,
    requirePermission('utility_kpi.read'),
    utilityKpiHandler,
  );

  return router;
}
