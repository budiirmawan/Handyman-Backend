import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  closeIncidentHandler,
  getClosureStatusHandler,
  listClosureStatusesHandler,
} from './incident-closure.controller';

/**
 * BE-21K — Incident Closure routes.
 *
 * Closure is a state of the Incident, so these hang off `/incidents/:id`.
 *
 * The permission split is the substance of "unauthorized closure rejected":
 * `incident_closure.read` sees readiness and its blockers, while only
 * `incident_closure.manage` may actually seal an Incident. Holding
 * `incident.manage` — enough to report and edit an Incident — is deliberately
 * NOT enough to close one: sealing the record is a distinct authority, and
 * keeping them separable is the point.
 *
 * The static collection is registered before the `:id` routes so it is never
 * shadowed.
 */
export function createIncidentClosureRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('incident_closure.read');
  const manage = requirePermission('incident_closure.manage');

  router.get('/incident-closures', auth, read, listClosureStatusesHandler);

  router.get(
    '/incidents/:id/closure',
    auth,
    read,
    getClosureStatusHandler,
  );
  router.post(
    '/incidents/:id/closure',
    auth,
    manage,
    closeIncidentHandler,
  );

  return router;
}
