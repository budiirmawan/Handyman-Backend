/**
 * CR-HM-15 PART 05 — PUBLISHED READ CONTRACT barrel (CR-HM-17/18).
 *
 * Read-only, versioned publication of the CR-HM-15 families: bounded
 * owner statuses, immutable anchors (client / execution scope / BAST /
 * warranty / claim / rework / chargeable additional work), history
 * instants and non-authoritative readiness facts — plus the Asset-Warranty
 * firewall checks. ZERO new lifecycle authority, ZERO new vocabulary,
 * ZERO writes, ZERO financial calculation, ZERO FM/SaaS projection, no
 * HTTP/OpenAPI.
 */

export {
  HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION,
  HANDYMAN_SERVICE_WARRANTY_CONTRACT_SOURCE,
  HANDYMAN_SERVICE_WARRANTY_CONTRACT_FAMILIES,
} from './handyman-service-warranty-contract.types';
export type {
  HandymanServiceWarrantyContractFamily,
  HandymanServiceWarrantyContractCoverageFact,
  HandymanServiceWarrantyContractWarrantyFact,
  HandymanServiceWarrantyContractClaimFact,
  HandymanServiceWarrantyContractReworkFact,
  HandymanServiceWarrantyContractChargeableFact,
  HandymanServiceWarrantyContractAnchors,
  HandymanServiceWarrantyContractHistory,
  HandymanServiceWarrantyContractLifecycle,
  HandymanServiceWarrantyContractReadiness,
  HandymanServiceWarrantyContract,
} from './handyman-service-warranty-contract.types';

export {
  HANDYMAN_ASSET_WARRANTY_FIREWALL,
  HANDYMAN_NOT_SERVICE_WARRANTY_CONTRACT_SOURCE,
  HANDYMAN_SERVICE_WARRANTY_CONTRACT_FORBIDDEN_KEY_PATTERN,
  HANDYMAN_SERVICE_WARRANTY_CONTRACT_FORBIDDEN_ASSET_PATTERN,
  isNotServiceWarrantyContractSourceAlias,
  assertHandymanServiceWarrantyContractSource,
  assertHandymanServiceWarrantyContractStartSource,
  assertHandymanServiceWarrantyContractShape,
} from './handyman-service-warranty-contract.firewall';
export type {
  HandymanNotServiceWarrantyContractSource,
} from './handyman-service-warranty-contract.firewall';

export {
  readHandymanServiceWarrantyContractByWarrantyId,
  readHandymanServiceWarrantyContractByExecutionScopeId,
  readHandymanServiceWarrantyClaimContract,
  readHandymanServiceWarrantyReworkContract,
  readHandymanChargeableAdditionalWorkContract,
} from './handyman-service-warranty-contract.reader';
