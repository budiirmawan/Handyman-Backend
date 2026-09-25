import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createSafetyInspectionBindingHandler,
  getSafetyInspectionBindingHandler,
  updateSafetyInspectionBindingHandler,
} from './safety-inspection-binding.controller';

/**
 * CR-BE-RN19-SAFETY-INSPECTION-01 — configuration routes only.
 * Building access is asserted after the schedule/binding context is resolved;
 * there is intentionally no list endpoint or Safety-specific execution route.
 */
export function createSafetyInspectionBindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('safety_inspection.read');
  const manage = requirePermission('safety_inspection.manage');

  router.post(
    '/safety/inspection-bindings',
    auth,
    manage,
    createSafetyInspectionBindingHandler,
  );
  router.get(
    '/safety/inspection-bindings/:id',
    auth,
    read,
    getSafetyInspectionBindingHandler,
  );
  router.patch(
    '/safety/inspection-bindings/:id',
    auth,
    manage,
    updateSafetyInspectionBindingHandler,
  );

  return router;
}
