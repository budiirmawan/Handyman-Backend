/**
 * CR-BE-SAAS-01 PART 10A/B — Tenant health + commercial dashboard
 * public surface.
 */
export { getTenantHealth } from './tenant-health.service';
export {
  SAAS_HEALTH_FAILURE_LOOKBACK_DAYS_DEFAULT,
  SAAS_HEALTH_FAILURE_LOOKBACK_KEY,
  SAAS_NEAR_RENEWAL_DAYS,
  SAAS_QUOTA_PRESSURE_RATIO,
  SAAS_REQUIRED_COMPONENTS,
} from './tenant-health.types';
export type {
  SaasTenantHealth,
  SaasTenantHealthComponent,
  SaasTenantHealthComponentReport,
  SaasTenantHealthEvidence,
  SaasTenantHealthOverallStatus,
} from './tenant-health.types';
export { getCommercialSummary } from './dashboard.service';
export type {
  SaasCommercialBuildingsEntry,
  SaasCommercialCollectionBucket,
  SaasCommercialCustomerCounts,
  SaasCommercialCurrencyBucket,
  SaasCommercialHealthCounts,
  SaasCommercialOutstandingBucket,
  SaasCommercialSubscriptionCounts,
  SaasCommercialSummary,
} from './dashboard.types';
export { createPlatformHealthRouter } from './platform-health.routes';
