import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import {
  getCurrentShiftHandler,
  getUpcomingShiftsHandler,
} from './mobile-current-shift.controller';

/**
 * BE-25M — Mobile Current Shift Contract.
 *
 *   GET /mobile/current-shift
 *   GET /mobile/upcoming-shifts            (CR-BE-MOB-05 PART 01)
 *
 * Authentication-only. The backend derives the caller's effective current
 * shift(s) — and, on the upcoming endpoint, the caller's current/future
 * shift schedule — from the authenticated Workforce Profile, the BE-03E
 * Shift roster and the BE-02F/G Building access authority. No permission
 * gate is required because only the caller's own roster is ever returned
 * (self-service, the same posture as `GET /auth/me`); Shift CRUD stays on
 * the BE-03E administration surface and is deliberately not exposed here.
 */
export function createMobileCurrentShiftRouter(): Router {
  const router = Router();

  router.get(
    '/mobile/current-shift',
    authenticationMiddleware,
    getCurrentShiftHandler,
  );

  router.get(
    '/mobile/upcoming-shifts',
    authenticationMiddleware,
    getUpcomingShiftsHandler,
  );

  return router;
}
