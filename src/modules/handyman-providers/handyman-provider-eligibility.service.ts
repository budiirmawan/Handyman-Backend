import { moduleConfigurationService } from '../module-configurations';
import { serviceCatalogRepository } from '../service-catalog';
import { vendorBuildingRepository } from '../vendor-buildings';
import { vendorCapabilityRepository } from '../vendor-capabilities';
import { vendorRepository } from '../vendors';
import { handymanProviderNotFoundError } from './handyman-provider.errors';
import { handymanProviderRepository } from './handyman-provider.repository';
import { HANDYMAN_MODULE_CODE } from './handyman-provider.service';
import type { EffectiveModuleConfiguration } from '../module-configurations';
import type {
  AuthorizedHandymanProvider,
  BuildingHandymanEnablement,
  HandymanCapabilityScope,
  HandymanProviderServiceEligibility,
} from './handyman-provider.types';

/**
 * CR-HM-BE-02 RUN 2 — Building enablement, Provider ↔ Building
 * authorization, and Provider ↔ Service Catalog eligibility authority.
 *
 * Pure composition over existing foundations; no algorithm is duplicated:
 * - Enablement delegates entirely to the BE-27C effective module
 *   configuration projection, which already composes the BE-02C commercial
 *   chain (Subscription ∧ License ∧ Entitlement ∧ Module) with the
 *   configuration intent (Building row overriding Client row) and is itself
 *   version-aware through BE-27N/O.
 * - Provider ↔ Building authorization reuses the Run 1 designation
 *   authority, the BE-06A vendor registry, and the BE-06D relationship
 *   semantics (partial-unique ACTIVE row; optional window; NULL window =
 *   undated, standing until deactivated).
 * - Service eligibility reuses the BE-06E capability catalog and the
 *   CR-BE-SVC-01 governed `service_catalog` identity link.
 *
 * Fail-closed doctrine: anything unavailable, INACTIVE, out of window, out
 * of Client scope, or outside the Handyman category convention resolves to
 * "not enabled / not authorized / not eligible" — never to an error and
 * never to an optimistic default. Building access (BE-02G) and inactive
 * client errors propagate from the underlying authorities unchanged.
 */

/**
 * CR-HM-BE-02 v1 category convention identifying Handyman services inside
 * the Client's existing `service_catalog`. This constant + the helper below
 * are the SINGLE home of the convention — no query or service may scatter
 * the literal. Promotion to a governed marker is a documented deferral.
 */
export const HANDYMAN_SERVICE_CATEGORY = 'HANDYMAN';

/** Fail-closed category check: anything not matching the convention is out. */
export function isHandymanServiceCategory(category: string): boolean {
  return category.trim().toUpperCase() === HANDYMAN_SERVICE_CATEGORY;
}

/**
 * BE-06D window semantics, identical to the CR-HM-BE-01 `isEffectiveNow`
 * idiom: a NULL bound is an undated (standing) side of the window; present
 * bounds are inclusive.
 */
function isRelationshipEffectiveNow(
  relationship: { effectiveFrom: Date | null; effectiveUntil: Date | null },
  now: number = Date.now(),
): boolean {
  return (
    (relationship.effectiveFrom === null ||
      relationship.effectiveFrom.getTime() <= now) &&
    (relationship.effectiveUntil === null ||
      relationship.effectiveUntil.getTime() >= now)
  );
}

/**
 * A. Effective Handyman state of one Building.
 *
 * Enabled requires BOTH the effective commercial HANDYMAN entitlement AND
 * the effective building module configuration enabled — exactly the BE-27C
 * projection's `enabled = configuredEnabled ∧ entitled`, with the Building
 * row overriding the Client row. A missing HANDYMAN entry (no module, no
 * configuration, or no entitlement path) fails closed to all-false.
 *
 * Propagates the underlying authority errors unchanged: BE-02G
 * BUILDING_ACCESS_DENIED (unknown buildings are denied without existence
 * leaks) and CLIENT_INACTIVE.
 */
export async function getBuildingHandymanEnablement(
  buildingId: string,
  actorUserId: string,
): Promise<BuildingHandymanEnablement> {
  const effective =
    await moduleConfigurationService.getEffectiveBuildingModuleConfiguration(
      buildingId,
      actorUserId,
    );
  return projectHandymanEnablement(buildingId, effective);
}

/**
 * Access-neutral enablement projection (CR-HM-BE-06 Run 2 §11): the
 * IDENTICAL BE-27C projection rule as {@link getBuildingHandymanEnablement}
 * — same `enabled = configuredEnabled ∧ entitled` fold, same fail-closed
 * missing-entry semantics — resolved through the preauthorized BE-27C
 * effective-configuration read. Callers MUST be independently preauthorized
 * for the Building (the governed Handyman Work Session start command proves
 * visit-scoped field authority through the BE-06 lead chain).
 */
export async function getBuildingHandymanEnablementPreauthorized(
  buildingId: string,
): Promise<BuildingHandymanEnablement> {
  const effective =
    await moduleConfigurationService.getEffectiveBuildingModuleConfigurationPreauthorized(
      buildingId,
    );
  return projectHandymanEnablement(buildingId, effective);
}

function projectHandymanEnablement(
  buildingId: string,
  effective: EffectiveModuleConfiguration,
): BuildingHandymanEnablement {
  const entry = effective.modules.find(
    (module) => module.moduleKey === HANDYMAN_MODULE_CODE,
  );
  return {
    buildingId: effective.buildingId ?? buildingId,
    clientId: effective.clientId,
    enabled: entry?.enabled ?? false,
    entitled: entry?.entitled ?? false,
    configuredEnabled: entry?.configuredEnabled ?? false,
  };
}

/**
 * B. Designated Handyman Providers authorized for one Building right now.
 *
 * A Provider is authorized only when ALL hold:
 *   1. the Building is Handyman-effectively-enabled (A),
 *   2. the Run 1 designation is ACTIVE,
 *   3. the underlying BE-06A Vendor exists, is ACTIVE, and resolves to the
 *      Building's Client (defensive re-check of the Run 1 invariant),
 *   4. an ACTIVE BE-06D Vendor ↔ Building relationship exists for the pair
 *      and is effective now (NULL window = standing).
 *
 * A disabled Building authorizes nobody (empty list — fail closed, not an
 * error). `handyman_providers` deliberately carries no building_id: the
 * relationship row is the sole building scope.
 */
export async function listAuthorizedHandymanProvidersForBuilding(
  buildingId: string,
  actorUserId: string,
): Promise<AuthorizedHandymanProvider[]> {
  const enablement = await getBuildingHandymanEnablement(buildingId, actorUserId);
  return listAuthorizedProvidersForEnablement(buildingId, enablement);
}

/**
 * Access-neutral provider ↔ building authorization (CR-HM-BE-06 Run 2 §11):
 * the IDENTICAL B rules as {@link listAuthorizedHandymanProvidersForBuilding}
 * (enablement fail-closed, ACTIVE designation, ACTIVE same-client vendor,
 * ACTIVE-and-effective relationship) with the preauthorized enablement read.
 * Callers MUST be independently preauthorized for the Building.
 */
export async function listAuthorizedHandymanProvidersForBuildingPreauthorized(
  buildingId: string,
): Promise<AuthorizedHandymanProvider[]> {
  const enablement =
    await getBuildingHandymanEnablementPreauthorized(buildingId);
  return listAuthorizedProvidersForEnablement(buildingId, enablement);
}

async function listAuthorizedProvidersForEnablement(
  buildingId: string,
  enablement: BuildingHandymanEnablement,
): Promise<AuthorizedHandymanProvider[]> {
  if (!enablement.enabled) {
    return [];
  }

  const designations = await handymanProviderRepository.listByClient(
    enablement.clientId,
    { status: 'ACTIVE' },
  );

  const authorized: AuthorizedHandymanProvider[] = [];
  for (const designation of designations) {
    const vendor = await vendorRepository.findById(designation.vendorId);
    if (
      !vendor ||
      vendor.status !== 'ACTIVE' ||
      vendor.clientId !== enablement.clientId
    ) {
      continue;
    }

    const relationship =
      await vendorBuildingRepository.findActiveByVendorAndBuilding(
        vendor.id,
        buildingId,
      );
    if (!relationship || !isRelationshipEffectiveNow(relationship)) {
      continue;
    }

    authorized.push({
      providerId: designation.id,
      buildingId,
      clientId: enablement.clientId,
      vendorId: vendor.id,
      vendorCode: vendor.vendorCode,
      vendorName: vendor.vendorName,
      relationshipId: relationship.id,
    });
  }
  return authorized;
}

/**
 * C. Service Catalog services one designated Provider is eligible to
 * perform at one Building.
 *
 * The Provider must first pass B. A capability yields an eligible service
 * only when ALL hold:
 *   1. the capability is ACTIVE,
 *   2. it carries a governed `service_catalog_id` (legacy code-only
 *      capabilities fail closed — no governed identity, no eligibility),
 *   3. the catalog entry exists, is ACTIVE, and belongs to the Building's
 *      Client (defensive same-client re-check),
 *   4. the entry matches the Handyman category convention (fail closed for
 *      every non-Handyman category),
 *   5. the capability is vendor-wide (NULL relationship = applies at every
 *      authorized Building) OR scoped through a relationship that is the
 *      requested Building's, ACTIVE, and effective now.
 *
 * A designation that is unknown, deactivated, or simply not authorized at
 * this Building is indistinguishable from the outside (404 — the BE-02G
 * no-existence-leak doctrine applied to the building scope).
 */
export async function listHandymanProviderServiceEligibilities(
  buildingId: string,
  providerId: string,
  actorUserId: string,
): Promise<HandymanProviderServiceEligibility[]> {
  const authorizedProviders = await listAuthorizedHandymanProvidersForBuilding(
    buildingId,
    actorUserId,
  );
  return listEligibilitiesForAuthorizedProviders(
    buildingId,
    providerId,
    authorizedProviders,
  );
}

/**
 * Access-neutral provider ↔ service eligibility (CR-HM-BE-06 Run 2 §11):
 * the IDENTICAL C rules as {@link listHandymanProviderServiceEligibilities}
 * (B-gate fail-closed to the 404 no-existence-leak doctrine, capability
 * coverage, governed catalog identity, category convention, capability
 * scope windows) with the preauthorized B read. Callers MUST be
 * independently preauthorized for the Building.
 */
export async function listHandymanProviderServiceEligibilitiesPreauthorized(
  buildingId: string,
  providerId: string,
): Promise<HandymanProviderServiceEligibility[]> {
  const authorizedProviders =
    await listAuthorizedHandymanProvidersForBuildingPreauthorized(buildingId);
  return listEligibilitiesForAuthorizedProviders(
    buildingId,
    providerId,
    authorizedProviders,
  );
}

async function listEligibilitiesForAuthorizedProviders(
  buildingId: string,
  providerId: string,
  authorizedProviders: AuthorizedHandymanProvider[],
): Promise<HandymanProviderServiceEligibility[]> {
  const provider = authorizedProviders.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (!provider) {
    throw handymanProviderNotFoundError();
  }

  const capabilities = await vendorCapabilityRepository.listByVendor(
    provider.vendorId,
  );

  const eligible: HandymanProviderServiceEligibility[] = [];
  for (const capability of capabilities) {
    if (capability.status !== 'ACTIVE') continue;
    if (!capability.serviceCatalogId) continue;

    const service = await serviceCatalogRepository.findById(
      undefined,
      capability.serviceCatalogId,
    );
    if (!service || service.status !== 'ACTIVE') continue;
    if (service.clientId !== provider.clientId) continue;
    if (!isHandymanServiceCategory(service.category)) continue;

    let capabilityScope: HandymanCapabilityScope;
    if (capability.vendorBuildingRelationshipId === null) {
      capabilityScope = 'VENDOR_WIDE';
    } else {
      const relationship = await vendorBuildingRepository.findById(
        capability.vendorBuildingRelationshipId,
      );
      if (!relationship) continue;
      if (relationship.vendorId !== provider.vendorId) continue;
      if (relationship.buildingId !== buildingId) continue;
      if (relationship.status !== 'ACTIVE') continue;
      if (!isRelationshipEffectiveNow(relationship)) continue;
      capabilityScope = 'BUILDING_SCOPED';
    }

    eligible.push({
      providerId: provider.providerId,
      buildingId,
      vendorId: provider.vendorId,
      capabilityId: capability.id,
      capabilityScope,
      serviceCatalogId: service.id,
      serviceCode: service.code,
      serviceName: service.name,
    });
  }
  return eligible;
}

export const handymanProviderEligibilityService = {
  getBuildingHandymanEnablement,
  getBuildingHandymanEnablementPreauthorized,
  isHandymanServiceCategory,
  listAuthorizedHandymanProvidersForBuilding,
  listAuthorizedHandymanProvidersForBuildingPreauthorized,
  listHandymanProviderServiceEligibilities,
  listHandymanProviderServiceEligibilitiesPreauthorized,
};
