/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — browser push subscription
 * authority (S-1).
 *
 * The BROWSER half of the multi-client push contract. The APK half is the
 * native token authority (`push-tokens`); both feed the SAME durable
 * outbound ledger and the SAME client-neutral notification payloads.
 */
export {
  browserPushSubscriptionNotFoundError,
  browserPushSubscriptionService,
  findBrowserPushSubscriptionById,
  isValidBrowserPushAuthSecret,
  isValidBrowserPushPublicKey,
  listActiveBrowserPushSubscriptionsForUser,
  listBrowserPushSubscriptions,
  registerBrowserPushSubscription,
  revokeAllBrowserPushSubscriptions,
  revokeBrowserPushSubscription,
  validateRegisterBrowserPushSubscriptionInput,
} from './browser-push-subscription.service';
export {
  BROWSER_PUSH_SUBSCRIPTION_ENTITY_TYPE,
  BROWSER_PUSH_SUBSCRIPTION_INVALIDATED_EVENT,
  reconcileInvalidBrowserSubscriptionEvidence,
} from './browser-push-subscription-invalidation.service';
export type {
  BrowserPushSubscriptionInvalidationOutcome,
  BrowserPushSubscriptionInvalidationSkip,
  BrowserPushSubscriptionInvalidationSkipReason,
  BrowserPushSubscriptionInvalidated,
} from './browser-push-subscription-invalidation.service';
export { recordBrowserPushAttemptTelemetry } from './browser-push-subscription-telemetry.service';
export type {
  BrowserPushSubscriptionTelemetryAttempt,
  BrowserPushSubscriptionTelemetryOutcome,
  BrowserPushSubscriptionTelemetrySkipReason,
} from './browser-push-subscription-telemetry.service';
export {
  listBrowserPushSubscriptionsHandler,
  registerBrowserPushSubscriptionHandler,
  revokeAllBrowserPushSubscriptionsHandler,
  revokeBrowserPushSubscriptionHandler,
} from './browser-push-subscription.controller';
export { createBrowserPushSubscriptionRouter } from './browser-push-subscription.routes';
export {
  BROWSER_PUSH_SUBSCRIPTION_STATUSES,
} from './browser-push-subscription.types';
export type {
  BrowserPushSubscriptionRecord,
  BrowserPushSubscriptionStatus,
  PublicBrowserPushSubscription,
  RegisterBrowserPushSubscriptionInput,
} from './browser-push-subscription.types';
