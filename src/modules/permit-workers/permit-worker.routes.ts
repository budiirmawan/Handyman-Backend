import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  addPermitWorkerHandler,
  deactivatePermitWorkerHandler,
  getPermitWorkerHandler,
  listPermitWorkersForPermitHandler,
  listPermitWorkersHandler,
  resolveActivePermitWorkersHandler,
  updatePermitWorkerHandler,
} from './permit-worker.controller';

/** BE-20H Permit list bindings over the existing Workforce masters. */
export function createPermitWorkerRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('permit.read');
  const manage = requirePermission('permit.manage');

  router.post('/permits/:permitId/workers', auth, manage, addPermitWorkerHandler);
  router.get(
    '/permits/:permitId/workers/active',
    auth,
    read,
    resolveActivePermitWorkersHandler,
  );
  router.get(
    '/permits/:permitId/workers',
    auth,
    read,
    listPermitWorkersForPermitHandler,
  );
  router.get('/permit-workers', auth, read, listPermitWorkersHandler);
  router.post(
    '/permit-workers/:id/deactivate',
    auth,
    manage,
    deactivatePermitWorkerHandler,
  );
  router.get('/permit-workers/:id', auth, read, getPermitWorkerHandler);
  router.patch('/permit-workers/:id', auth, manage, updatePermitWorkerHandler);

  return router;
}
