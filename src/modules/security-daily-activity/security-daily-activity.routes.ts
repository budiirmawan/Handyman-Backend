import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import { getSecurityDailyActivityHandler } from './security-daily-activity.controller';

/**
 * BE-12F — Security Daily Activity endpoint.
 *
 *   GET /buildings/:buildingId/security/daily-activity
 *     ?date=YYYY-MM-DD[&shiftId=...][&securityPostId=...]
 *
 * A lightweight read-model that composes existing authoritative records
 * (BE-12A/B/C/D/E + BE-07 + BE-09) into a single per-Building, per-date
 * view. No new operational tables; the underlying records remain
 * authoritative. `available_actions` on each open Finding is sourced from
 * BE-09's `findingActionService` (backend-authoritative).
 */
export function createSecurityDailyActivityRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('security_daily_activity.read');

  router.get(
    '/buildings/:buildingId/security/daily-activity',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    getSecurityDailyActivityHandler,
  );

  return router;
}
