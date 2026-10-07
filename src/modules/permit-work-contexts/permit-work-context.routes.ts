import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignPermitWorkLocationHandler,
  assignPermitWorkTypeHandler,
  getApplicationWorkContextHandler,
  getPermitWorkContextHandler,
  listPermitWorkContextsHandler,
  updatePermitWorkContextHandler,
} from './permit-work-context.controller';

/** BE-20D Work Location / Type over the authoritative BE-04 structure. */
export function createPermitWorkContextRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('permit.read');
  const manage = requirePermission('permit.manage');

  router.put(
    '/permit-applications/:id/work-location',
    auth,
    manage,
    assignPermitWorkLocationHandler,
  );
  router.put(
    '/permit-applications/:id/work-type',
    auth,
    manage,
    assignPermitWorkTypeHandler,
  );
  router.get(
    '/permit-applications/:id/work-context',
    auth,
    read,
    getApplicationWorkContextHandler,
  );
  router.patch(
    '/permit-applications/:id/work-context',
    auth,
    manage,
    updatePermitWorkContextHandler,
  );
  router.get(
    '/permits/:permitId/work-context',
    auth,
    read,
    getPermitWorkContextHandler,
  );
  router.get(
    '/permit-work-contexts',
    auth,
    read,
    listPermitWorkContextsHandler,
  );

  return router;
}
