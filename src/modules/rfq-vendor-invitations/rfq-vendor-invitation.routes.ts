import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { rfqVendorSessionMiddleware } from './rfq-vendor-session.middleware';
import {
  acceptVendorRfqInvitationHandler,
  createRfqVendorInvitationHandler,
  declineVendorRfqInvitationHandler,
  exchangeRfqVendorInvitationTokenHandler,
  getRfqVendorInvitationHandler,
  getVendorRfqMeHandler,
  getVendorSafeInvitationHandler,
  getVendorSafeRfqHandler,
  listAccessibleRfqVendorInvitationsHandler,
  listRfqVendorInvitationsHandler,
  noBidVendorRfqInvitationHandler,
  resendRfqVendorInvitationHandler,
  revokeRfqVendorInvitationHandler,
} from './rfq-vendor-invitation.controller';

/**
 * CR-BE-PRO-02 PART 02 — internal invitation management plus the dedicated
 * external Vendor RFQ session boundary.
 *
 * Internal routes use `rfq.read` / `rfq.manage`. External routes deliberately
 * do not use internal authentication or RBAC; the dedicated invitation-scoped
 * session middleware is their only authentication boundary.
 */
export function createRfqVendorInvitationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('rfq.read');
  const manage = requirePermission('rfq.manage');

  // Internal RFQ management.
  router.post('/rfqs/:rfqId/invitations', auth, manage, createRfqVendorInvitationHandler);
  router.get('/rfqs/:rfqId/invitations', auth, read, listRfqVendorInvitationsHandler);
  router.get('/rfq-vendor-invitations', auth, read, listAccessibleRfqVendorInvitationsHandler);
  router.get('/rfq-vendor-invitations/:id', auth, read, getRfqVendorInvitationHandler);
  router.post('/rfq-vendor-invitations/:id/resend', auth, manage, resendRfqVendorInvitationHandler);
  router.post('/rfq-vendor-invitations/:id/revoke', auth, manage, revokeRfqVendorInvitationHandler);

  // External Vendor session exchange. The token is accepted only in the POST
  // body; it is never parsed from a URL path or query string.
  router.post('/vendor-rfq-access/exchange', exchangeRfqVendorInvitationTokenHandler);
  router.get('/vendor-rfq-access/me', rfqVendorSessionMiddleware, getVendorRfqMeHandler);
  router.get('/vendor-rfq-access/rfqs/:rfqId', rfqVendorSessionMiddleware, getVendorSafeRfqHandler);
  router.get('/vendor-rfq-access/invitations/:invitationId', rfqVendorSessionMiddleware, getVendorSafeInvitationHandler);
  router.post('/vendor-rfq-access/invitations/:invitationId/accept', rfqVendorSessionMiddleware, acceptVendorRfqInvitationHandler);
  router.post('/vendor-rfq-access/invitations/:invitationId/decline', rfqVendorSessionMiddleware, declineVendorRfqInvitationHandler);
  router.post('/vendor-rfq-access/invitations/:invitationId/no-bid', rfqVendorSessionMiddleware, noBidVendorRfqInvitationHandler);

  return router;
}
