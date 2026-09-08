import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { workforceKpiHandler } from './workforce-kpi.controller';

/**
 * BE-23G — Workforce KPI endpoint.
 *
 *   GET /workforce/reports/kpi
 *     [?buildingId=...][&workforceId=...][&teamId=...]
 *     [&workforceType=INTERNAL|OUTSOURCED|CONTRACT]
 *     [&dateFrom=YYYY-MM-DD][&dateTo=YYYY-MM-DD][&graceMinutes=N]
 *
 * Requires authentication plus `workforce_kpi.read`. Omitting
 * `buildingId` rolls the KPI up across every accessible Building.
 *
 * Read-only: direct queries over the BE-03 Workforce records and the
 * BE-07 Task / assignment store. No ETL, no warehouse, and no mutation
 * of source domain state.
 */
export function createWorkforceKpiRouter(): Router {
  const router = Router();

  router.get(
    '/workforce/reports/kpi',
    authenticationMiddleware,
    requirePermission('workforce_kpi.read'),
    workforceKpiHandler,
  );

  return router;
}
