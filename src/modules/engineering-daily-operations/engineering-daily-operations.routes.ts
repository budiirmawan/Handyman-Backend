import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import { getDailyEngineeringOperationsHandler } from './engineering-daily-operations.controller';

/**
 * BE-10A — Daily Engineering Operations endpoint.
 *
 *   GET /buildings/:buildingId/engineering/daily-operations
 *       ?date=YYYY-MM-DD&shiftId=<uuid>
 *
 * READ-ONLY BY DESIGN — a consolidated view over authoritative BE-07/08/09
 * records. There is deliberately no POST / PATCH / DELETE: operations are
 * authored through their own domains, never through this endpoint.
 *
 * Middleware order: authenticate → RBAC (`engineering.read`) → BE-02G
 * Building isolation → controller.
 */
export function createEngineeringDailyOperationsRouter(): Router {
  const router = Router();

  router.get(
    '/buildings/:buildingId/engineering/daily-operations',
    authenticationMiddleware,
    requirePermission('engineering.read'),
    requireBuildingAccess('buildingId'),
    getDailyEngineeringOperationsHandler,
  );

  return router;
}
