import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createDeliveryCourierHandler,
  getDeliveryCourierHandler,
  listDeliveryCouriersHandler,
  updateDeliveryCourierStatusHandler,
} from './delivery-courier.controller';

/**
 * BE-13K — Delivery / Courier context endpoints. This surface reuses
 * Visitor and Visit references where applicable and intentionally does
 * not implement the BE-13L Front Desk Log.
 */
export function createDeliveryCourierRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('delivery_courier.read');
  const manage = requirePermission('delivery_courier.manage');

  router.post(
    '/delivery-couriers',
    auth,
    manage,
    createDeliveryCourierHandler,
  );
  router.get(
    '/delivery-couriers',
    auth,
    read,
    listDeliveryCouriersHandler,
  );
  router.get(
    '/delivery-couriers/:id',
    auth,
    read,
    getDeliveryCourierHandler,
  );
  router.patch(
    '/delivery-couriers/:id/status',
    auth,
    manage,
    updateDeliveryCourierStatusHandler,
  );

  return router;
}
