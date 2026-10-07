import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import {
  getMobileVerificationHandler,
  submitMobileVerificationHandler,
} from './mobile-verification.controller';

/**
 * BE-25J — Supervisor Verification Contract.
 *
 *   GET  /mobile/verification/:targetType/:targetId
 *   POST /mobile/verification/:targetType/:targetId   { decision, notes? }
 *
 * Mobile supervisor verification over the shared BE-07 review authority
 * (CHECKLIST_EXECUTION / FORM_INSTANCE) and the BE-09 finding verification
 * workflow (FINDING). Thin composition of the existing services — no
 * separate mobile verification engine. Per-target-type RBAC (review.* /
 * finding.*) is enforced in the service, identical to the Web endpoints.
 */
export function createMobileVerificationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get(
    '/mobile/verification/:targetType/:targetId',
    auth,
    getMobileVerificationHandler,
  );
  router.post(
    '/mobile/verification/:targetType/:targetId',
    auth,
    submitMobileVerificationHandler,
  );

  return router;
}
