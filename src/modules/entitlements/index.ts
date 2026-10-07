export {
  entitlementAlreadyExistsError,
  entitlementCommercialContextInvalidError,
  entitlementNotFoundError,
  saasEntitlementNotFoundError,
  saasQuotaExceededError,
} from './entitlement.errors';

export { entitlementRepository } from './entitlement.repository';

export {
  applyEntitlementOverride,
  assertCapabilityAccess,
  assertQuotaAvailable,
  createEntitlement,
  entitlementService,
  getEntitlementById,
  isSubscriptionEffectivelyLicensed,
  listEntitlements,
  listEntitlementsBySubscriptionId,
  resolveCapabilityAccess,
  resolveEffectiveEntitlements,
  resolveEffectiveLimit,
  syncPackageEntitlements,
  toPublicEntitlement,
  updateEntitlementStatus,
  validateEntitlementPeriod,
} from './entitlement.service';

export {
  ENTITLEMENT_SOURCES,
  ENTITLEMENT_STATUSES,
  isEntitlementSource,
  isEntitlementStatus,
} from './entitlement.types';

export {
  parseCreateEntitlementBody,
  parseEntitlementIdParam,
  parseEntitlementSubscriptionIdParam,
  parseUpdateEntitlementStatusBody,
} from './entitlement.validation';

export type {
  CreateEntitlementInput,
  EffectiveModuleSummary,
  EntitlementRecord,
  EntitlementSource,
  EntitlementStatus,
  NewEntitlement,
  OverrideEntitlementInput,
  PublicEntitlement,
  UpdateEntitlementStatusInput,
} from './entitlement.types';

export type { ValidationDetail } from './entitlement.validation';
