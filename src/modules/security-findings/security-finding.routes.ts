import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createSecurityFindingHandler,
  getSecurityFindingHandler,
  listSecurityFindingsHandler,
} from './security-finding.controller';

/**
 * BE-12H — Security Finding Binding endpoints.
 *
 *   POST /security/findings
 *   GET  /security/findings
 *   GET  /security/findings/:id
 *
 * Findings stay BE-09's: creation, classification/severity, assignment,
 * state transitions, verification, rework, closure, history, and
 * available actions all live on BE-09's own endpoints/services. This
 * router only adds the Security context binding and read model — no
 * duplicated Finding workflow endpoints. Workflow action endpoints
 * (assign / transition / source / cancel / available-actions) are
 * reused from BE-09's own `/findings/:id/...` routes.
 */
export function createSecurityFindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('security_finding.manage');
  const read = requirePermission('security_finding.read');

  router.post('/security/findings', auth, manage, createSecurityFindingHandler);
  router.get('/security/findings', auth, read, listSecurityFindingsHandler);
  router.get('/security/findings/:id', auth, read, getSecurityFindingHandler);

  return router;
}
