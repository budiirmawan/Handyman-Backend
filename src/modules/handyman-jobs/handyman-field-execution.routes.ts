import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  endHandymanWorkSessionHandler,
  getHandymanVisitPresenceHandler,
  getHandymanWorkSessionHandler,
  listHandymanVisitArrivalsHandler,
  listHandymanWorkSessionsHandler,
  recordAssistedHandymanVisitArrivalHandler,
  recordAssistedHandymanVisitPresenceHandler,
  recordGpsHandymanVisitArrivalHandler,
  recordHandymanVisitPresenceByLeadHandler,
  startHandymanWorkSessionHandler,
} from './handyman-field-execution.controller';

/**
 * CR-HM-BE-06 RUN 3 — Handyman field-execution HTTP contract (arrival,
 * presence, work session), registered through the existing Asentra route
 * composition (no separate server/runtime). Every route requires an
 * authenticated session; RBAC then gates per route with EXISTING
 * permission codes only (no new role or permission is introduced):
 *
 * - `handyman_work_execution.manage` → the field commands: GPS arrival,
 *   lead presence marking, guarded session start, session end.
 * - `handyman_work_execution.read`   → the privacy-safe reads: arrival
 *   history, presence view, session list/detail.
 * - `handyman_service_visit.manage`  → the ASSISTED staff-override routes
 *   (assisted arrival, assisted presence) — the established assisted-staff
 *   authority from Run 1. Assisted routes are deliberately NOT reachable
 *   with `handyman_work_execution.manage` alone: a field credential can
 *   never self-attest an assisted override.
 *
 * There is deliberately NO generic CRUD here: no DELETE (facts are
 * append-only / converged, never removed), no PATCH/PUT (no lifecycle
 * mutation — statuses are server-managed), no QR/material/QC/BAST/invoice/
 * payment surface, and no work-order or vendor-work transition endpoint
 * (the guarded start seam inside the session service remains the only
 * convergence path, and the owning transition services stay unchanged).
 * All authorization beyond RBAC (lead chain, snapshot membership, read
 * data scope, readiness, lifecycle consistency) stays service-owned —
 * controllers and routes decide nothing.
 */
export function createHandymanFieldExecutionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const executionRead = requirePermission('handyman_work_execution.read');
  const executionManage = requirePermission('handyman_work_execution.manage');
  const visitManage = requirePermission('handyman_service_visit.manage');

  // Visit arrival (Run 1): GPS evidence command, staff-assisted override and
  // the privacy-safe attempt history (raw coordinates never leave the server).
  router.post(
    '/handyman-service-visits/:visitId/arrival',
    auth,
    executionManage,
    recordGpsHandymanVisitArrivalHandler,
  );
  router.post(
    '/handyman-service-visits/:visitId/arrival/assisted',
    auth,
    visitManage,
    recordAssistedHandymanVisitArrivalHandler,
  );
  router.get(
    '/handyman-service-visits/:visitId/arrivals',
    auth,
    executionRead,
    listHandymanVisitArrivalsHandler,
  );

  // Crew presence (Run 1): the frozen snapshot view, the lead field path and
  // the staff-assisted override (helpers never authenticate).
  router.get(
    '/handyman-service-visits/:visitId/presence',
    auth,
    executionRead,
    getHandymanVisitPresenceHandler,
  );
  router.post(
    '/handyman-service-visits/:visitId/presence',
    auth,
    executionManage,
    recordHandymanVisitPresenceByLeadHandler,
  );
  router.post(
    '/handyman-service-visits/:visitId/presence/assisted',
    auth,
    visitManage,
    recordAssistedHandymanVisitPresenceHandler,
  );

  // Work session (Run 2): guarded execution start (the ONLY convergence
  // seam), the visit's session history, one session by id and the
  // replay-safe end.
  router.post(
    '/handyman-service-visits/:visitId/work-sessions/start',
    auth,
    executionManage,
    startHandymanWorkSessionHandler,
  );
  router.get(
    '/handyman-service-visits/:visitId/work-sessions',
    auth,
    executionRead,
    listHandymanWorkSessionsHandler,
  );
  router.get(
    '/handyman-work-sessions/:sessionId',
    auth,
    executionRead,
    getHandymanWorkSessionHandler,
  );
  router.post(
    '/handyman-work-sessions/:sessionId/end',
    auth,
    executionManage,
    endHandymanWorkSessionHandler,
  );

  return router;
}
