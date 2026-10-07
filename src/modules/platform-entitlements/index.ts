/**
 * CR-BE-SAAS-01 PART 04 — SaaS Entitlement & Quota module (SaaS Control
 * Plane).
 *
 * Bounded module: src/modules/platform-entitlements/
 *
 * PART 04 makes the PART 02/03 commercial chain runtime-effective
 * (frozen §12): the existing `module_entitlements` authority is EXTENDED
 * with `source` + `limit_value` (0365) — no parallel entitlement table;
 * the EXISTING `resolveEffectiveEntitlements` resolver is extended, never
 * replaced. PACKAGE-source grants are materialized deterministically at
 * subscription activation (wired into the PART 03 transaction); the
 * customer-scoped resolution seam (`resolveCapabilityAccess` /
 * `resolveEffectiveLimit` / `assertCapabilityAccess` /
 * `assertQuotaAvailable`) is the reusable business-plane authority.
 *
 * This module owns exactly the frozen §22 entitlement surface
 * (GET resolved / POST console OVERRIDE). Usage metering (PART 09),
 * suspension policy (PART 08), add-ons, and the tenant-side
 * /me/entitlements projection (PART 10) are deliberately absent.
 */
export { createPlatformEntitlementRouter } from './platform-entitlement.routes';
export {
  getSaasEntitlements,
  overrideSaasEntitlement,
  platformEntitlementService,
} from './platform-entitlement.service';
export { parseOverrideSaasEntitlementBody } from './platform-entitlement.validation';
export type {
  OverrideSaasEntitlementInput,
  PublicSaasEntitlementCapability,
  PublicSaasEntitlementLimit,
  PublicSaasEntitlementResolved,
} from './platform-entitlement.types';
