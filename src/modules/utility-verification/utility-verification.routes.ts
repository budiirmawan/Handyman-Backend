import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getLatestVerificationHandler,
  getVerificationContextHandler,
  listVerificationsHandler,
  openVerificationHandler,
  submitVerificationHandler,
} from './utility-verification.controller';

/**
 * BE-18K — Utility Verification endpoints, protected by BE-01 RBAC and BE-02
 * Client / Building isolation (enforced in the service once the abnormal
 * consumption's Building is resolved). Reuses the BE-07 review primitive; the
 * utility permissions from BE-18A carry over unchanged.
 *
 * Reads (`utility_meter.read`):
 *   GET  /utility/abnormal-consumptions/:id/verification         context + state
 *   GET  /utility/abnormal-consumptions/:id/verification/latest  latest result
 *   GET  /utility/abnormal-consumptions/:id/verifications        full history
 * Management (`utility_meter.manage`):
 *   POST /utility/abnormal-consumptions/:id/verification/open    open a review
 *   POST /utility/abnormal-consumptions/:id/verification         submit decision
 *
 * Tenant Approval Binding (BE-18L) is deliberately not exposed here.
 */
export function createUtilityVerificationRouter(): Router {
  const router = Router();

  router.get(
    '/utility/abnormal-consumptions/:id/verification',
    authenticationMiddleware,
    requirePermission('utility_meter.read'),
    getVerificationContextHandler,
  );
  router.get(
    '/utility/abnormal-consumptions/:id/verification/latest',
    authenticationMiddleware,
    requirePermission('utility_meter.read'),
    getLatestVerificationHandler,
  );
  router.get(
    '/utility/abnormal-consumptions/:id/verifications',
    authenticationMiddleware,
    requirePermission('utility_meter.read'),
    listVerificationsHandler,
  );

  router.post(
    '/utility/abnormal-consumptions/:id/verification/open',
    authenticationMiddleware,
    requirePermission('utility_meter.manage'),
    openVerificationHandler,
  );
  router.post(
    '/utility/abnormal-consumptions/:id/verification',
    authenticationMiddleware,
    requirePermission('utility_meter.manage'),
    submitVerificationHandler,
  );

  return router;
}
