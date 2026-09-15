import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelPermitHandler,
  createPermitHandler,
  getPermitHandler,
  listPermitsHandler,
  updatePermitHandler,
} from './permit.controller';

/**
 * BE-20A — one shared Permit foundation for Vendor and Tenant Contractors.
 * Later BE-20 workflows must build on these records rather than add another
 * Permit domain.
 */
export function createPermitRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('permit.read');
  const manage = requirePermission('permit.manage');

  router.post('/permits', auth, manage, createPermitHandler);
  router.get('/permits', auth, read, listPermitsHandler);
  router.post('/permits/:id/cancel', auth, manage, cancelPermitHandler);
  router.get('/permits/:id', auth, read, getPermitHandler);
  router.patch('/permits/:id', auth, manage, updatePermitHandler);

  return router;
}
