import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import {
  deactivatePushTokenHandler,
  listPushTokensHandler,
  registerPushTokenHandler,
} from './push-token.controller';

/**
 * BE-25L — Push Token Registration.
 *
 *   POST   /mobile/push-tokens
 *   GET    /mobile/push-tokens
 *   DELETE /mobile/push-tokens/:tokenId
 *
 * Backend registration of mobile push notification tokens, bound to the
 * authenticated user/device context. Supports refresh/rotation and
 * deactivation/unregistration. No notification delivery engine exists yet
 * (BE-26).
 */
export function createPushTokenRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.post('/mobile/push-tokens', auth, registerPushTokenHandler);
  router.get('/mobile/push-tokens', auth, listPushTokensHandler);
  router.delete('/mobile/push-tokens/:tokenId', auth, deactivatePushTokenHandler);

  return router;
}
