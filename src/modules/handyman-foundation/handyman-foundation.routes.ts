import { Router } from 'express';

/**
 * HC-00 PART 01 — Handyman bounded-context router.
 *
 * Permanent namespace gateway for the Handyman bounded context. It is
 * intentionally empty: HC-01+ wave routers mount under
 * HANDYMAN_API_NAMESPACE so every Handyman route is served under /handyman.
 * No business behavior lives here.
 */
export function createHandymanRouter(): Router {
  const router = Router();
  return router;
}
