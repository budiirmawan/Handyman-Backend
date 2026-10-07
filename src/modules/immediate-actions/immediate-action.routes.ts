import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelImmediateActionHandler,
  completeImmediateActionHandler,
  createImmediateActionHandler,
  getImmediateActionHandler,
  listImmediateActionsHandler,
  startImmediateActionHandler,
  updateImmediateActionHandler,
} from './immediate-action.controller';

/**
 * BE-21E — Immediate Action routes.
 *
 * Unlike BE-21B/C/D these address the ACTION's own id, not the Incident id:
 * an Incident has many immediate actions, so `/immediate-actions/:id` is the
 * action itself. Listing by Incident is a filter (`?incidentId=`), keeping
 * BE-21A's `/incidents` namespace free of child endpoints.
 *
 * Status changes are dedicated verbs rather than a PATCH field, so completion
 * can capture who completed it and when, and so an illegal transition is a
 * distinct, explicit failure rather than a silently ignored field.
 *
 * RBAC is default-deny; the service additionally asserts Building access
 * against the parent INCIDENT, so holding the permission is never sufficient
 * to reach another Building.
 */
export function createImmediateActionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('immediate_action.read');
  const manage = requirePermission('immediate_action.manage');

  router.post('/immediate-actions', auth, manage, createImmediateActionHandler);
  router.get('/immediate-actions', auth, read, listImmediateActionsHandler);

  // Verb routes are registered before `/:id` so they are never shadowed.
  router.post(
    '/immediate-actions/:id/start',
    auth,
    manage,
    startImmediateActionHandler,
  );
  router.post(
    '/immediate-actions/:id/complete',
    auth,
    manage,
    completeImmediateActionHandler,
  );
  router.post(
    '/immediate-actions/:id/cancel',
    auth,
    manage,
    cancelImmediateActionHandler,
  );

  router.get('/immediate-actions/:id', auth, read, getImmediateActionHandler);
  router.patch(
    '/immediate-actions/:id',
    auth,
    manage,
    updateImmediateActionHandler,
  );

  return router;
}
