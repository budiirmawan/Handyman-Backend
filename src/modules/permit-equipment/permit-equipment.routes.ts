import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  addPermitEquipmentHandler,
  deactivatePermitEquipmentHandler,
  getPermitEquipmentHandler,
  listPermitEquipmentForPermitHandler,
  listPermitEquipmentHandler,
  resolveActivePermitEquipmentHandler,
  updatePermitEquipmentHandler,
} from './permit-equipment.controller';

/** BE-20I Permit bindings over existing Asset/Equipment foundations. */
export function createPermitEquipmentRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('permit.read');
  const manage = requirePermission('permit.manage');
  router.post('/permits/:permitId/equipment', auth, manage, addPermitEquipmentHandler);
  router.get('/permits/:permitId/equipment/active', auth, read, resolveActivePermitEquipmentHandler);
  router.get('/permits/:permitId/equipment', auth, read, listPermitEquipmentForPermitHandler);
  router.get('/permit-equipment', auth, read, listPermitEquipmentHandler);
  router.post('/permit-equipment/:id/deactivate', auth, manage, deactivatePermitEquipmentHandler);
  router.get('/permit-equipment/:id', auth, read, getPermitEquipmentHandler);
  router.patch('/permit-equipment/:id', auth, manage, updatePermitEquipmentHandler);
  return router;
}
