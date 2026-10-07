import { Router } from 'express';
import {
  acceptHandoffAssertionHandler,
  bindHandoffAttributionHandler,
} from './handoff.controller';

/**
 * CR-HM-01 PART 05 — secure handoff routes. Mounted by createApiRouter()
 * under the versioned API prefix (/api/v1); frozen D3 forbids any exposure
 * under /webhooks.
 */
export function createHandoffHandymanRouter(): Router {
  const router = Router();

  router.post('/handoff/assertions', acceptHandoffAssertionHandler);
  router.post(
    '/handoff/channel-attributions',
    bindHandoffAttributionHandler,
  );

  return router;
}
