import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  activateHandymanWorkCrewHandler,
  addHandymanWorkCrewMemberHandler,
  changeHandymanWorkCrewLeadWorkerHandler,
  createHandymanWorkCrewHandler,
  deactivateHandymanWorkCrewHandler,
  getHandymanWorkCrewHandler,
  listHandymanWorkCrewMembersHandler,
  listHandymanWorkCrewsHandler,
  removeHandymanWorkCrewMemberHandler,
  updateHandymanWorkCrewHandler,
} from './handyman-work-crew.controller';

/**
 * CR-HM-BE-04 RUN 2 — Handyman Work Crew HTTP contract, registered through
 * the existing Asentra route composition (no separate server/runtime). Every
 * route requires an authenticated session; RBAC then gates per route with
 * ONLY the existing Run-1 permissions:
 *
 * - `handyman_work_crew.read`   → crew and membership reads
 * - `handyman_work_crew.manage` → crew create/rename/lifecycle, member
 *   add/remove, and the atomic lead change
 *
 * Client access, provider-designation validity, worker-binding validation,
 * the lead invariant, lifecycle guards, and concurrency all remain
 * service-authoritative (Run 1). There is deliberately NO DELETE route
 * (history is never deleted), no crew/request or crew/work-order assignment
 * route, and no dispatch surface (CR-HM-BE-04 boundary).
 */
export function createHandymanWorkCrewRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('handyman_work_crew.read');
  const manage = requirePermission('handyman_work_crew.manage');

  router.post('/handyman-work-crews', auth, manage, createHandymanWorkCrewHandler);
  router.get('/handyman-work-crews', auth, read, listHandymanWorkCrewsHandler);
  router.get('/handyman-work-crews/:crewId', auth, read, getHandymanWorkCrewHandler);
  router.patch('/handyman-work-crews/:crewId', auth, manage, updateHandymanWorkCrewHandler);
  router.post(
    '/handyman-work-crews/:crewId/deactivate',
    auth,
    manage,
    deactivateHandymanWorkCrewHandler,
  );
  router.post(
    '/handyman-work-crews/:crewId/activate',
    auth,
    manage,
    activateHandymanWorkCrewHandler,
  );
  router.post(
    '/handyman-work-crews/:crewId/members',
    auth,
    manage,
    addHandymanWorkCrewMemberHandler,
  );
  router.get(
    '/handyman-work-crews/:crewId/members',
    auth,
    read,
    listHandymanWorkCrewMembersHandler,
  );
  router.post(
    '/handyman-work-crews/:crewId/members/:memberId/remove',
    auth,
    manage,
    removeHandymanWorkCrewMemberHandler,
  );
  router.post(
    '/handyman-work-crews/:crewId/lead-worker/change',
    auth,
    manage,
    changeHandymanWorkCrewLeadWorkerHandler,
  );

  return router;
}
