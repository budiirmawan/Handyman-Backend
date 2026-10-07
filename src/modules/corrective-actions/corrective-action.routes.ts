import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  approveCorrectiveActionHandler,
  cancelCorrectiveActionHandler,
  completeCorrectiveActionHandler,
  createCorrectiveActionHandler,
  getCorrectiveActionDueDateHandler,
  getCorrectiveActionHandler,
  listCorrectiveActionsHandler,
  rejectCorrectiveActionHandler,
  setCorrectiveActionDueDateHandler,
  startCorrectiveActionHandler,
  updateCorrectiveActionHandler,
} from './corrective-action.controller';

/**
 * BE-21G — Corrective Action routes.
 *
 * Like BE-21E these address the ACTION's own id, not the Incident id: an
 * Incident has many corrective actions, so `/corrective-actions/:id` is the
 * action itself. Listing by Incident is a filter (`?incidentId=`), keeping
 * BE-21A's `/incidents` namespace free of child endpoints.
 *
 * Status changes are dedicated verbs rather than a PATCH field, so each
 * transition can capture its own metadata (who approved, why it was rejected,
 * who completed it) and an illegal transition is an explicit failure rather
 * than a silently ignored field.
 *
 * RBAC is default-deny; the service additionally asserts Building access
 * against the parent INCIDENT, so holding the permission is never sufficient
 * to reach another Building.
 */
export function createCorrectiveActionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('corrective_action.read');
  const manage = requirePermission('corrective_action.manage');

  router.post('/corrective-actions', auth, manage, createCorrectiveActionHandler);
  router.get('/corrective-actions', auth, read, listCorrectiveActionsHandler);

  // Verb routes are registered before `/:id` so they are never shadowed.
  router.post(
    '/corrective-actions/:id/approve',
    auth,
    manage,
    approveCorrectiveActionHandler,
  );
  router.post(
    '/corrective-actions/:id/reject',
    auth,
    manage,
    rejectCorrectiveActionHandler,
  );
  router.post(
    '/corrective-actions/:id/start',
    auth,
    manage,
    startCorrectiveActionHandler,
  );
  router.post(
    '/corrective-actions/:id/complete',
    auth,
    manage,
    completeCorrectiveActionHandler,
  );
  router.post(
    '/corrective-actions/:id/cancel',
    auth,
    manage,
    cancelCorrectiveActionHandler,
  );

  /**
   * BE-21I — the deadline as a named sub-resource, registered BEFORE `/:id`
   * so it is never shadowed.
   *
   * It is its own endpoint rather than a PATCH field for the same reason the
   * status verbs are: setting a deadline captures provenance and writes its
   * own history entry, and must not be possible as a side effect of editing
   * the remedy text. PUT (not POST) because a Corrective Action has exactly
   * one deadline — setting it twice is idempotent replacement, not creation.
   *
   * Reading the deadline needs only `read`; changing it needs `manage`.
   */
  router.put(
    '/corrective-actions/:id/due-date',
    auth,
    manage,
    setCorrectiveActionDueDateHandler,
  );
  router.get(
    '/corrective-actions/:id/due-date',
    auth,
    read,
    getCorrectiveActionDueDateHandler,
  );

  router.get('/corrective-actions/:id', auth, read, getCorrectiveActionHandler);
  router.patch(
    '/corrective-actions/:id',
    auth,
    manage,
    updateCorrectiveActionHandler,
  );

  return router;
}
