import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assessHandymanServiceVisitExecutionReadinessHandler,
  cancelHandymanServiceVisitScheduleHandler,
  createHandymanServiceVisitHandler,
  getHandymanServiceVisitHandler,
  listHandymanJobServiceVisitsHandler,
  listHandymanServiceVisitSchedulesHandler,
  rescheduleHandymanServiceVisitHandler,
} from './handyman-service-visit.controller';

/**
 * CR-HM-BE-05 RUN 3 — Handyman Service Visit scheduling HTTP contract,
 * registered through the existing Asentra route composition (no separate
 * server/runtime). Every route requires an authenticated session; RBAC then
 * gates per route:
 *
 * - `handyman_service_visit.manage` → visit creation, reschedule, cancel
 * - `handyman_service_visit.read`   → visit/schedule-history reads and the
 *   pure execution-readiness assessment (a READ — no mutation, no event)
 *
 * There is deliberately NO direct schedule-row CRUD (windows exist only
 * through the governed create/reschedule/cancel commands and the visit read
 * model), NO PATCH on schedules, and NO arrival / check-in / WorkSession /
 * execution-start surface. Schedule-time revalidation, half-open temporal
 * crew/worker conflict protection, the one-ACTIVE-window invariant, guarded
 * closure and the BE-15D permit-readiness passthrough remain
 * service-authoritative (Run 2).
 */
export function createHandymanServiceVisitRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('handyman_service_visit.read');
  const manage = requirePermission('handyman_service_visit.manage');

  router.post(
    '/handyman-jobs/:jobId/visits',
    auth,
    manage,
    createHandymanServiceVisitHandler,
  );
  router.get(
    '/handyman-jobs/:jobId/visits',
    auth,
    read,
    listHandymanJobServiceVisitsHandler,
  );
  router.get(
    '/handyman-service-visits/:visitId',
    auth,
    read,
    getHandymanServiceVisitHandler,
  );
  router.get(
    '/handyman-service-visits/:visitId/schedules',
    auth,
    read,
    listHandymanServiceVisitSchedulesHandler,
  );
  router.post(
    '/handyman-service-visits/:visitId/reschedule',
    auth,
    manage,
    rescheduleHandymanServiceVisitHandler,
  );
  router.post(
    '/handyman-service-visits/:visitId/cancel',
    auth,
    manage,
    cancelHandymanServiceVisitScheduleHandler,
  );
  router.get(
    '/handyman-service-visits/:visitId/execution-readiness',
    auth,
    read,
    assessHandymanServiceVisitExecutionReadinessHandler,
  );

  return router;
}
