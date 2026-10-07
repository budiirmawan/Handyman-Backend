import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getPermitValidityHandler,
  listPermitValiditiesHandler,
  resolveCurrentPermitValidityHandler,
  revokePermitValidityHandler,
  setPermitValidityHandler,
} from './permit-validity.controller';

/** BE-20G backend-authoritative Permit validity lifecycle. */
export function createPermitValidityRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('permit.read');
  const manage = requirePermission('permit.manage');

  router.post(
    '/permits/:permitId/validity',
    auth,
    manage,
    setPermitValidityHandler,
  );
  router.get(
    '/permits/:permitId/validity',
    auth,
    read,
    resolveCurrentPermitValidityHandler,
  );
  router.get(
    '/permits/:permitId/validity/current',
    auth,
    read,
    resolveCurrentPermitValidityHandler,
  );
  router.get('/permit-validities', auth, read, listPermitValiditiesHandler);
  router.post(
    '/permit-validities/:id/revoke',
    auth,
    manage,
    revokePermitValidityHandler,
  );
  router.get('/permit-validities/:id', auth, read, getPermitValidityHandler);

  return router;
}
