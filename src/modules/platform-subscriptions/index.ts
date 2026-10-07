/**
 * CR-BE-SAAS-01 PART 03 — SaaS Subscription module (SaaS Control Plane).
 *
 * Bounded module: src/modules/platform-subscriptions/
 *
 * The canonical SaaS Subscription aggregate lives on the existing
 * `subscriptions` foundation (0013 + 0364 extension) — no parallel
 * authority (frozen §6/§11.1). PART 03 owns the lifecycle command surface
 * (create DRAFT / activate / convert / renew / cancel / terminate /
 * non-status PATCH) with optimistic concurrency, canonical idempotency,
 * canonical audit, and the §7.2 customer-status re-projection.
 * Entitlement materialization (PART 04), the §11.4 billing sweep and
 * §11.5 reactivation (PART 08) are deliberately absent.
 */
export { createPlatformSubscriptionRouter } from './platform-subscription.routes';
export { platformSubscriptionRepository } from './platform-subscription.repository';
export {
  activateSaasSubscription,
  cancelSaasSubscription,
  convertSaasSubscription,
  createSaasSubscription,
  getSaasSubscriptionDetail,
  listSaasSubscriptions,
  renewSaasSubscription,
  terminateSaasSubscription,
  toPublicSaasSubscription,
  updateSaasSubscription,
  SAAS_SUBSCRIPTION_ACTIVATED_EVENT,
  SAAS_SUBSCRIPTION_CANCELLED_EVENT,
  SAAS_SUBSCRIPTION_CHANGED_EVENT,
  SAAS_SUBSCRIPTION_CREATED_EVENT,
  SAAS_SUBSCRIPTION_TERMINATED_EVENT,
  SAAS_SUBSCRIPTION_ACTIVATE_OPERATION_KEY,
  SAAS_SUBSCRIPTION_CONVERT_OPERATION_KEY,
  SAAS_SUBSCRIPTION_CREATE_OPERATION_KEY,
} from './platform-subscription.service';
export * from './platform-subscription.types';
