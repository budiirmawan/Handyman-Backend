import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createFindingEscalationHandler,
  getFindingEscalationHandler,
  listFindingEscalationsHandler,
  updateFindingEscalationHandler,
} from './finding-escalation.controller';

/**
 * BE-21D — Finding Escalation routes.
 *
 * These address the SHARED BE-21A Incident id: `/finding-escalations/:id`
 * takes the Incident id, so there is one identity across the foundation and
 * its specialization. Cancellation stays on the BE-21A endpoint
 * (`POST /incidents/:id/cancel`), and acting on the Finding itself stays on
 * BE-09's `/findings` routes — BE-21D must not offer a second way to do
 * either.
 *
 * Listing by Finding is a filter on this collection (`?findingId=`) rather
 * than a nested `/findings/:id/escalations` route: BE-09 owns the `/findings`
 * namespace, and an Incident specialization must not graft Incident endpoints
 * onto it.
 *
 * RBAC is default-deny; the service additionally asserts Building access, so
 * holding the permission is never sufficient to reach another Building.
 */
export function createFindingEscalationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('finding_escalation.read');
  const manage = requirePermission('finding_escalation.manage');

  router.post(
    '/finding-escalations',
    auth,
    manage,
    createFindingEscalationHandler,
  );
  router.get('/finding-escalations', auth, read, listFindingEscalationsHandler);
  router.get(
    '/finding-escalations/:id',
    auth,
    read,
    getFindingEscalationHandler,
  );
  router.patch(
    '/finding-escalations/:id',
    auth,
    manage,
    updateFindingEscalationHandler,
  );

  return router;
}
