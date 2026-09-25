/**
 * CR-BE-SAAS-01 PART 07 — Payment & Reconciliation routes (frozen §22).
 *
 * Permission gating per frozen §22:
 *   - read endpoints (`platform.payment.read`): list payments, get payment
 *   - reconcile / reject (frozen §22 row): `platform.payment.reconcile`
 *
 * The `POST /platform/payments` (ingestion) row is gated on
 * `platform.billing.manage` per frozen §22 (provider-neutral PENDING
 * ingest is a billing event, not a reconciliation event).
 */
import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import {
  getSaasPaymentDetailHandler,
  ingestSaasPaymentHandler,
  listSaasPaymentsHandler,
  reconcileSaasPaymentHandler,
  rejectSaasPaymentHandler,
} from './platform-payments.controller';

export function createPlatformPaymentsRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get(
    '/platform/payments',
    auth,
    requirePlatformPermission('platform.payment.read'),
    listSaasPaymentsHandler,
  );

  router.post(
    '/platform/payments',
    auth,
    requirePlatformPermission('platform.billing.manage'),
    ingestSaasPaymentHandler,
  );

  router.get(
    '/platform/payments/:paymentId',
    auth,
    requirePlatformPermission('platform.payment.read'),
    getSaasPaymentDetailHandler,
  );

  router.post(
    '/platform/payments/:paymentId/reconcile',
    auth,
    requirePlatformPermission('platform.payment.reconcile'),
    reconcileSaasPaymentHandler,
  );

  router.post(
    '/platform/payments/:paymentId/reject',
    auth,
    requirePlatformPermission('platform.payment.reconcile'),
    rejectSaasPaymentHandler,
  );

  return router;
}
