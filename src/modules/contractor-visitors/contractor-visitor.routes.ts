import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createContractorVisitorHandler,
  getContractorVisitorHandler,
  listContractorVisitorsHandler,
  updateContractorVisitorHandler,
} from './contractor-visitor.controller';

/**
 * BE-13J — Contractor Visitor metadata over the existing BE-13 visit
 * lifecycle. Delivery / Courier behavior is intentionally not included.
 */
export function createContractorVisitorRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('contractor_visitor.read');
  const manage = requirePermission('contractor_visitor.manage');

  router.post(
    '/contractor-visitors',
    auth,
    manage,
    createContractorVisitorHandler,
  );
  router.get(
    '/contractor-visitors',
    auth,
    read,
    listContractorVisitorsHandler,
  );
  router.get(
    '/contractor-visitors/:id',
    auth,
    read,
    getContractorVisitorHandler,
  );
  router.patch(
    '/contractor-visitors/:id',
    auth,
    manage,
    updateContractorVisitorHandler,
  );

  return router;
}
