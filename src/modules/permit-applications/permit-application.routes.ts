import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelPermitApplicationHandler,
  createPermitApplicationHandler,
  getPermitApplicationHandler,
  listPermitApplicationsHandler,
  submitPermitApplicationHandler,
  updatePermitApplicationHandler,
} from './permit-application.controller';

/** BE-20C Permit Application routes; no location, safety, or approval flow. */
export function createPermitApplicationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('permit.read');
  const manage = requirePermission('permit.manage');

  router.post('/permit-applications', auth, manage, createPermitApplicationHandler);
  router.get('/permit-applications', auth, read, listPermitApplicationsHandler);
  router.post(
    '/permit-applications/:id/submit',
    auth,
    manage,
    submitPermitApplicationHandler,
  );
  router.post(
    '/permit-applications/:id/cancel',
    auth,
    manage,
    cancelPermitApplicationHandler,
  );
  router.get('/permit-applications/:id', auth, read, getPermitApplicationHandler);
  router.patch(
    '/permit-applications/:id',
    auth,
    manage,
    updatePermitApplicationHandler,
  );

  return router;
}
