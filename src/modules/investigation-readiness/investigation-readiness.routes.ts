import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getInvestigationReadinessHandler,
  listInvestigationReadinessHandler,
} from './investigation-readiness.controller';

/**
 * BE-21F — Investigation Readiness routes.
 *
 * Readiness is a PROPERTY OF an Incident, not a resource of its own, so it is
 * exposed as a sub-resource of the BE-21A Incident it describes:
 * `GET /incidents/:id/investigation-readiness`. It has no id, cannot be
 * addressed independently, and there is no collection of readiness records —
 * because none are stored.
 *
 * Every route is a GET. There is deliberately no POST/PATCH and no
 * `investigation_readiness.manage` permission: a computed projection has
 * nothing to manage, and offering a write verb would imply readiness can be
 * overridden — precisely the stored-status design this PART must avoid.
 *
 * `investigation_readiness.read` is a distinct permission rather than a reuse
 * of `incident.read`: readiness aggregates operational preparedness across an
 * estate, which is a broader disclosure than reading one Incident.
 *
 * RBAC is default-deny; the service additionally asserts Building access, so
 * holding the permission is never sufficient to reach another Building.
 */
export function createInvestigationReadinessRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('investigation_readiness.read');

  router.get(
    '/incidents/:id/investigation-readiness',
    auth,
    read,
    getInvestigationReadinessHandler,
  );
  router.get(
    '/investigation-readiness',
    auth,
    read,
    listInvestigationReadinessHandler,
  );

  return router;
}
