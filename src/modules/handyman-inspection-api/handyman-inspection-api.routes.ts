import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requireAnyPermission, requirePermission } from '../auth/rbac.middleware';
import {
  getHandymanInspectionAssignmentHandler,
  postHandymanInspectionAssignmentHandler,
} from './handyman-inspection-api.controller';

/**
 * CR-HM-INSPECTION-01 PART A — pre-quotation Field inspection assignment
 * surface (owner-approved additive authority).
 *
 *   POST /handyman/requests/:handymanRequestId/inspection-assignment
 *        handyman.operations.inspection.assign            write
 *   GET  /handyman/requests/:handymanRequestId/inspection-assignment
 *        tenant_company.read | handyman.operations.request.read    read
 *
 * This is a SEPARATE surface from the frozen eight-operation CR-HM-03
 * lifecycle router: the lifecycle router keeps its exact paths and its reads,
 * while its in-scope `POST /inspection` write now requires the dedicated Field
 * authority AND the active assignment enforced by the service (one writer,
 * no `tenant_company.manage` bypass).
 *
 * Writes here are strictly additive to the frozen F8 boundary: no request
 * status changes, no Execution Scope, no provider/crew identity, no
 * quotation, price or PIC authority. Reads reuse the existing scoped
 * request-read admission and the service applies the exact-Building guard.
 */
export function createHandymanInspectionApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const assignWrite = requirePermission(
    'handyman.operations.inspection.assign',
  );
  const read = requireAnyPermission([
    'tenant_company.read',
    'handyman.operations.request.read',
  ]);

  router.post(
    '/handyman/requests/:handymanRequestId/inspection-assignment',
    auth,
    assignWrite,
    postHandymanInspectionAssignmentHandler,
  );
  router.get(
    '/handyman/requests/:handymanRequestId/inspection-assignment',
    auth,
    read,
    getHandymanInspectionAssignmentHandler,
  );

  return router;
}
