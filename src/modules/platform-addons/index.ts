/**
 * CR-BE-SAAS-01 PART 13C — Add-on module (frozen §9.5 + §22).
 */
export { platformAddOnRepository } from './platform-addon.repository';
export {
  SAAS_ADD_ON_CHANGED_EVENT,
  SAAS_SUBSCRIPTION_ADD_ON_CHANGED_EVENT,
  attachSaasAddOn,
  createSaasAddOn,
  detachSaasAddOn,
  getSaasAddOnDetail,
  listSaasAddOns,
  updateSaasAddOn,
} from './platform-addon.service';
export { createPlatformAddOnRouter } from './platform-addon.routes';
export type {
  AttachSaasAddOnInput,
  CreateSaasAddOnInput,
  ListSaasAddOnFilters,
  SaasAddOnEntitlementEffect,
  SaasAddOnQuotaEffect,
  SaasAddOnRecord,
  SaasAddOnStatus,
  SaasSubscriptionAddOnDetail,
  SaasSubscriptionAddOnRecord,
  SaasSubscriptionAddOnStatus,
  UpdateSaasAddOnInput,
} from './platform-addon.types';
