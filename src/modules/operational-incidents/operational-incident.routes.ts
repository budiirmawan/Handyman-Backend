import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createOperationalIncidentHandler,
  getOperationalIncidentHandler,
  listOperationalIncidentsHandler,
  updateOperationalIncidentHandler,
} from './operational-incident.controller';

/**
 * BE-21B — Operational Incident routes.
 *
 * These address the SHARED BE-21A Incident id: `/operational-incidents/:id`
 * takes the Incident id, so there is one identity across the foundation and
 * its specialization. Cancellation stays on the BE-21A endpoint
 * (`POST /incidents/:id/cancel`) — the foundation owns the record lifecycle
 * and BE-21B must not offer a second way to end it.
 *
 * RBAC is default-deny; the service additionally asserts Building access, so
 * holding the permission is never sufficient to reach another Building.
 */
export function createOperationalIncidentRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('operational_incident.read');
  const manage = requirePermission('operational_incident.manage');

  router.post(
    '/operational-incidents',
    auth,
    manage,
    createOperationalIncidentHandler,
  );
  router.get(
    '/operational-incidents',
    auth,
    read,
    listOperationalIncidentsHandler,
  );
  router.get(
    '/operational-incidents/:id',
    auth,
    read,
    getOperationalIncidentHandler,
  );
  router.patch(
    '/operational-incidents/:id',
    auth,
    manage,
    updateOperationalIncidentHandler,
  );

  return router;
}
