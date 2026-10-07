import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getAcceptanceSignOffHandler, listAcceptanceSignOffsHandler, submitAcceptanceSignOffHandler } from './acceptance-sign-off.controller';

/**
 * BE-22E — Acceptance / Sign-Off via BAST / Handover.
 * Reuses BAST/Handover masters — no separate approval engine.
 */
export function createAcceptanceSignOffRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('document.read');
  const manage = requirePermission('document.manage');

  router.post('/acceptance-sign-offs', auth, manage, submitAcceptanceSignOffHandler);
  router.get('/acceptance-sign-offs', auth, read, listAcceptanceSignOffsHandler);
  router.get('/acceptance-sign-offs/:id', auth, read, getAcceptanceSignOffHandler);

  return router;
}
