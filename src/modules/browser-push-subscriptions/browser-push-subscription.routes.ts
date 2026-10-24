import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import {
  listBrowserPushSubscriptionsHandler,
  registerBrowserPushSubscriptionHandler,
  revokeAllBrowserPushSubscriptionsHandler,
  revokeBrowserPushSubscriptionHandler,
} from './browser-push-subscription.controller';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — browser push subscription
 * registration (the BROWSER contract).
 *
 *   POST   /mobile/push-subscriptions
 *   GET    /mobile/push-subscriptions
 *   DELETE /mobile/push-subscriptions/:subscriptionId
 *   DELETE /mobile/push-subscriptions
 *
 * This is a DISTINCT contract from the native APK token surface
 * (`/mobile/push-tokens`): the browser registers a SUBSCRIPTION (an endpoint
 * plus a key pair), the APK registers a provider TOKEN. The two never share
 * a payload, a schema or a row.
 *
 * Self-scoped and authenticated: the user id always comes from the session,
 * so a caller can only register, list and revoke their OWN subscriptions.
 * There is no send / test / resend route here and there never will be: the
 * push transport is driven by the durable outbound ledger, not by an API
 * call.
 */
export function createBrowserPushSubscriptionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.post('/mobile/push-subscriptions', auth, registerBrowserPushSubscriptionHandler);
  router.get('/mobile/push-subscriptions', auth, listBrowserPushSubscriptionsHandler);
  router.delete(
    '/mobile/push-subscriptions/:subscriptionId',
    auth,
    revokeBrowserPushSubscriptionHandler,
  );
  router.delete('/mobile/push-subscriptions', auth, revokeAllBrowserPushSubscriptionsHandler);

  return router;
}
