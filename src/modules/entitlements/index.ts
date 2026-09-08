export {
  entitlementAlreadyExistsError,
  entitlementCommercialContextInvalidError,
  entitlementNotFoundError,
} from './entitlement.errors';

export { entitlementRepository } from './entitlement.repository';

export {
  createEntitlement,
  entitlementService,
  getEntitlementById,
  listEntitlements,
  listEntitlementsBySubscriptionId,
  resolveEffectiveEntitlements,
  toPublicEntitlement,
  updateEntitlementStatus,
  validateEntitlementPeriod,
} from './entitlement.service';

export {
  ENTITLEMENT_STATUSES,
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
  EntitlementStatus,
  NewEntitlement,
  PublicEntitlement,
  UpdateEntitlementStatusInput,
} from './entitlement.types';

export type { ValidationDetail } from './entitlement.validation';
