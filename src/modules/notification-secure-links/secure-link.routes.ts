import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createSecureLinkHandler,
  getSecureLinkHandler,
  resolveSecureLinkHandler,
  revokeSecureLinkHandler,
} from './secure-link.controller';

/**
 * BE-26J — Notification secure link foundation.
 *
 *   POST /notification-links                     create (manage)
 *   POST /notification-links/resolve             resolve + consume (auth)
 *   GET  /notification-links/:linkId             status (read)
 *   POST /notification-links/:linkId/revoke      revoke (manage)
 *
 * Resolution is authenticated (recipient-bound, validated in the service);
 * creation/revocation/status are RBAC-protected (default-deny).
 */
export function createSecureLinkRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('notification_secure_link.read');
  const manage = requirePermission('notification_secure_link.manage');

  router.post('/notification-links', auth, manage, createSecureLinkHandler);
  router.post('/notification-links/resolve', auth, resolveSecureLinkHandler);
  router.get('/notification-links/:linkId', auth, read, getSecureLinkHandler);
  router.post('/notification-links/:linkId/revoke', auth, manage, revokeSecureLinkHandler);

  return router;
}
