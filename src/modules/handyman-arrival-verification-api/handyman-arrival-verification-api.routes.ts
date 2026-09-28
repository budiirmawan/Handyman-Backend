import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { postHandymanArrivalVerificationHandler }
  from './handyman-arrival-verification-api.controller';

/**
 * CR-HM-07 PART 04C — terminal arrival verification HTTP surface:
 *
 *   POST /handyman/execution-scopes/:executionScopeId/arrival-verification
 *
 * Authentication: any authenticated local session (existing Handyman
 * auth pattern). Eligibility/authority is NOT an RBAC gate: the PART
 * 04B evaluator enforces the authoritative CURRENT Crew Lead binding,
 * scope Client access, challenge validity and every terminal decision
 * server-side — no permission vocabulary is invented here and no
 * caller-supplied identity field is trusted. NO work-session/check-
 * in/FM route exists by design.
 */
export function createHandymanArrivalVerificationApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  router.post(
    '/handyman/execution-scopes/:executionScopeId/arrival-verification',
    auth,
    postHandymanArrivalVerificationHandler,
  );
  return router;
}
