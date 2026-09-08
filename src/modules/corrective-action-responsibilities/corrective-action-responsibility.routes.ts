import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignResponsiblePersonHandler,
  getResponsiblePersonHandler,
  listResponsibilitiesHandler,
  listResponsibilityHistoryHandler,
  releaseResponsiblePersonHandler,
  updateResponsiblePersonHandler,
} from './corrective-action-responsibility.controller';

/**
 * BE-21H — Responsible Person routes.
 *
 * Responsibility is a property OF a Corrective Action — at most one person is
 * accountable at a time — so it is a singular sub-resource rather than a
 * collection with its own ids:
 *
 *   POST   /corrective-actions/:id/responsible-person   assign
 *   GET    /corrective-actions/:id/responsible-person   the current person
 *   PATCH  /corrective-actions/:id/responsible-person   reassign / edit note
 *   DELETE /corrective-actions/:id/responsible-person   release
 *   GET    /corrective-actions/:id/responsible-person/history   full chain
 *
 * Addressing it by the CORRECTIVE ACTION's id is what makes "who is
 * responsible?" a single well-defined question. Superseded assignments are
 * still retrievable through `/history`, so nothing is lost by not giving them
 * addressable ids.
 *
 * `corrective_action_responsibility.*` is a distinct permission rather than a
 * reuse of `corrective_action.manage`: naming who is accountable is an
 * organizational decision, often held by a different role than the one that
 * proposes or approves the remedy itself.
 *
 * RBAC is default-deny; the service additionally asserts Building access
 * against the parent Incident, so holding the permission is never sufficient
 * to reach another Building.
 */
export function createCorrectiveActionResponsibilityRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('corrective_action_responsibility.read');
  const manage = requirePermission('corrective_action_responsibility.manage');

  // Registered before the singular route so it is never shadowed.
  router.get(
    '/corrective-actions/:id/responsible-person/history',
    auth,
    read,
    listResponsibilityHistoryHandler,
  );

  router.post(
    '/corrective-actions/:id/responsible-person',
    auth,
    manage,
    assignResponsiblePersonHandler,
  );
  router.get(
    '/corrective-actions/:id/responsible-person',
    auth,
    read,
    getResponsiblePersonHandler,
  );
  router.patch(
    '/corrective-actions/:id/responsible-person',
    auth,
    manage,
    updateResponsiblePersonHandler,
  );
  router.delete(
    '/corrective-actions/:id/responsible-person',
    auth,
    manage,
    releaseResponsiblePersonHandler,
  );

  router.get(
    '/corrective-action-responsibilities',
    auth,
    read,
    listResponsibilitiesHandler,
  );

  return router;
}
