import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  confirmVisitHandler,
  getHostConfirmationHandler,
  listHostConfirmationsHandler,
  rejectVisitHandler,
  requestHostConfirmationHandler,
} from './host-confirmation.controller';

/**
 * BE-13F — Host / Tenant Confirmation endpoints.
 *
 *   POST /host-confirmations
 *   GET  /host-confirmations
 *   GET  /host-confirmations/:id
 *   POST /host-confirmations/:id/confirm
 *   POST /host-confirmations/:id/reject
 *
 * Backend-authoritative confirmation over BE-13C / BE-13D visit
 * contexts. No new Tenant domain — the smallest safe host reference
 * from the visit is reused. PENDING → CONFIRMED | REJECTED, single
 * shot; REJECTED can never proceed as confirmed. No Check-In / Pass /
 * Check-Out semantics here.
 */
export function createHostConfirmationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('host_confirmation.manage');
  const read = requirePermission('host_confirmation.read');

  router.post(
    '/host-confirmations',
    auth,
    manage,
    requestHostConfirmationHandler,
  );
  router.get(
    '/host-confirmations',
    auth,
    read,
    listHostConfirmationsHandler,
  );
  router.get(
    '/host-confirmations/:id',
    auth,
    read,
    getHostConfirmationHandler,
  );
  router.post(
    '/host-confirmations/:id/confirm',
    auth,
    manage,
    confirmVisitHandler,
  );
  router.post(
    '/host-confirmations/:id/reject',
    auth,
    manage,
    rejectVisitHandler,
  );

  return router;
}
