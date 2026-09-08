import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  completeQualityAuditHandler,
  createQualityAuditHandler,
  getQualityAuditHandler,
  listQualityAuditsHandler,
  updateQualityAuditHandler,
} from './quality-audit.controller';

/**
 * BE-11K — Quality Audit endpoints.
 *
 *   POST  /housekeeping/quality-audits
 *   GET   /housekeeping/quality-audits
 *   GET   /housekeeping/quality-audits/:id
 *   PATCH /housekeeping/quality-audits/:id
 *   POST  /housekeeping/quality-audits/:id/complete
 */
export function createQualityAuditRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('quality_audit.manage');
  const read = requirePermission('quality_audit.read');

  router.post(
    '/housekeeping/quality-audits',
    auth,
    manage,
    createQualityAuditHandler,
  );
  router.get(
    '/housekeeping/quality-audits',
    auth,
    read,
    listQualityAuditsHandler,
  );
  router.get(
    '/housekeeping/quality-audits/:id',
    auth,
    read,
    getQualityAuditHandler,
  );
  router.patch(
    '/housekeeping/quality-audits/:id',
    auth,
    manage,
    updateQualityAuditHandler,
  );
  router.post(
    '/housekeeping/quality-audits/:id/complete',
    auth,
    manage,
    completeQualityAuditHandler,
  );

  return router;
}
