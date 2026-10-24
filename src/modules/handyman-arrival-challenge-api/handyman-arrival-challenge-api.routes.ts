import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { postHandymanArrivalChallengeHandler }
  from './handyman-arrival-challenge-api.controller';

/**
 * CR-HM-FIELD-OPS-ACK-01 PART 02 — arrival challenge issuance surface:
 *
 *   POST /handyman/execution-scopes/:executionScopeId/arrival-challenge
 *
 * Authentication: any authenticated local session (the existing Handyman
 * field pattern). Eligibility is NOT an RBAC gate — the PART 01 issuer
 * enforces the AUTHORIZED scope, BE-02G exact-Building access and the
 * CR-HM-04 authoritative CURRENT Crew Lead binding server-side, so no
 * permission vocabulary is invented here and no caller-supplied identity
 * is trusted. NO check-in / work-session / QR-registry / geofence-config
 * / FM route exists by design.
 */
export function createHandymanArrivalChallengeApiRouter(): Router {
  const router = Router();
  router.post(
    '/handyman/execution-scopes/:executionScopeId/arrival-challenge',
    authenticationMiddleware,
    postHandymanArrivalChallengeHandler,
  );
  return router;
}
