import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  listEvidenceHandler,
  listRequirementsHandler,
  removeEvidenceHandler,
  submitEvidenceHandler,
} from './work-order-evidence.controller';

/**
 * BE-08G — Work Order Evidence Binding endpoints, protected by BE-01 RBAC and
 * BE-02 Building isolation (enforced in the controller after resolving the
 * Work Order's Building). Reuses the BE-07 shared evidence engine.
 *
 * Reads (`work_order.read`):
 *   GET  /work-orders/:id/evidence-requirements
 *   GET  /work-orders/:id/evidence
 * Management (`work_order.manage`):
 *   POST   /work-orders/:id/evidence
 *   PATCH  /work-orders/:id/evidence/:evidenceId   (soft remove)
 *
 * No completion / verification endpoints are exposed here.
 */
export function createWorkOrderEvidenceRouter(): Router {
  const router = Router();

  router.get(
    '/work-orders/:id/evidence-requirements',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    listRequirementsHandler,
  );
  router.post(
    '/work-orders/:id/evidence',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    submitEvidenceHandler,
  );
  router.get(
    '/work-orders/:id/evidence',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    listEvidenceHandler,
  );
  router.patch(
    '/work-orders/:id/evidence/:evidenceId',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    removeEvidenceHandler,
  );

  return router;
}
