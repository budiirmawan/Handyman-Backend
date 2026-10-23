import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  classifyWorkOrderHandler,
  createTradeCategoryHandler,
  deactivateTradeCategoryHandler,
  getTradeCategoryHandler,
  getWorkOrderClassificationHandler,
  listTradeCategoriesHandler,
  updateTradeCategoryHandler,
} from './work-order-trade-category.controller';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A — the configurable multi-trade
 * registry and the Work Order classification step.
 *
 * Registry (configuration):
 *   GET   /work-order-trade-categories                       work_order.read
 *   POST  /work-order-trade-categories                       work_order.manage
 *   GET   /work-order-trade-categories/:tradeCategoryId      work_order.read
 *   PATCH /work-order-trade-categories/:tradeCategoryId      work_order.manage
 *   POST  /work-order-trade-categories/:tradeCategoryId/deactivate
 *                                                            work_order.manage
 *
 * Classification (Operations' triage decision on an existing Work Order):
 *   GET   /work-orders/:id/classification                    work_order.read
 *   PATCH /work-orders/:id/classification                    work_order.manage
 *
 * Both are additive: the existing Work Order endpoints keep their contract,
 * and classification lives on its own resource so `PublicWorkOrder` did not
 * change shape. Building isolation is enforced in the controller/service from
 * the Work Order row (BE-02G), never from a caller-supplied scope.
 */
export function createWorkOrderTradeCategoryRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('work_order.read');
  const manage = requirePermission('work_order.manage');
  const base = '/work-order-trade-categories';

  router.get(base, auth, read, listTradeCategoriesHandler);
  router.post(base, auth, manage, createTradeCategoryHandler);
  router.get(`${base}/:tradeCategoryId`, auth, read, getTradeCategoryHandler);
  router.patch(
    `${base}/:tradeCategoryId`,
    auth,
    manage,
    updateTradeCategoryHandler,
  );
  router.post(
    `${base}/:tradeCategoryId/deactivate`,
    auth,
    manage,
    deactivateTradeCategoryHandler,
  );

  router.get(
    '/work-orders/:id/classification',
    auth,
    read,
    getWorkOrderClassificationHandler,
  );
  router.patch(
    '/work-orders/:id/classification',
    auth,
    manage,
    classifyWorkOrderHandler,
  );

  return router;
}
