import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { getMyTeamHandler } from './mobile-my-team.controller';

/**
 * BE-25N — Mobile My Team Contract.
 *
 *   GET /mobile/my-team
 *
 * Authentication-only. The backend derives the caller's own team and its
 * ACTIVE members from the authenticated Workforce Profile, the BE-03B Team
 * hierarchy and the BE-02F/G Client scope. No permission gate is required
 * because only the caller's own team is ever returned (self-service, the same
 * posture as `GET /auth/me` and `GET /mobile/current-shift`); Team CRUD stays
 * on the BE-03B administration surface and is deliberately not exposed here.
 */
export function createMobileMyTeamRouter(): Router {
  const router = Router();

  router.get('/mobile/my-team', authenticationMiddleware, getMyTeamHandler);

  return router;
}
