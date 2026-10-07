import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelMaterialReservationHandler,
  createMaterialReservationHandler,
  getMaterialReservationHandler,
  listMaterialReservationsHandler,
  releaseMaterialReservationHandler,
} from './inventory-material-reservation.controller';

/**
 * CR-BE-INV-CONTROL-01 PART 01 — Material Reservation Foundation.
 *
 * Reservations allocate an existing approved Material Request against the
 * existing stock balance. They do not create a new demand or stock authority.
 * Mutations use inventory_stock.manage and reads use inventory_stock.read.
 */
export function createInventoryMaterialReservationRouter(): Router {
  const router = Router();

  router.post(
    '/material-requests/:materialRequestId/reservations',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    createMaterialReservationHandler,
  );

  router.get(
    '/material-requests/:materialRequestId/reservations',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listMaterialReservationsHandler,
  );

  router.get(
    '/material-reservations/:id',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    getMaterialReservationHandler,
  );

  router.post(
    '/material-reservations/:id/release',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    releaseMaterialReservationHandler,
  );

  router.post(
    '/material-reservations/:id/cancel',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    cancelMaterialReservationHandler,
  );

  return router;
}
