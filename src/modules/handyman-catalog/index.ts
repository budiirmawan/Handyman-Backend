/**
 * CR-HM-02 — Handyman Catalogue module (Handyman-owned composition on top
 * of the existing `service_catalog` master; see
 * `docs/handyman/CR-HM-02_START_GOVERNANCE.md`).
 */
export { handymanServiceVariantRepository } from './handyman-service-variant.repository';
export {
  createHandymanServiceVariant,
  getHandymanServiceVariant,
  handymanServiceVariantService,
  listHandymanServiceVariants,
} from './handyman-service-variant.service';
export {
  handymanServiceVariantCodeAlreadyExistsError,
  handymanServiceVariantNotActiveError,
  handymanServiceVariantNotFoundError,
} from './handyman-service-variant.errors';
export {
  HANDYMAN_SERVICE_VARIANT_STATUSES,
  isHandymanServiceVariantStatus,
} from './handyman-service-variant.types';
export type {
  CreateHandymanServiceVariantInput,
  HandymanServiceVariantFilters,
  HandymanServiceVariantRecord,
  HandymanServiceVariantStatus,
  NewHandymanServiceVariant,
  PublicHandymanServiceVariant,
} from './handyman-service-variant.types';
export {
  handymanCommonMaterialProfileRepository,
} from './handyman-common-material-profile.repository';
export {
  createHandymanCommonMaterialProfile,
  describeHandymanCommonMaterialProfile,
  handymanCommonMaterialProfileService,
  listHandymanCommonMaterialProfiles,
} from './handyman-common-material-profile.service';
export {
  handymanCommonMaterialProfileAlreadyExistsError,
  handymanCommonMaterialProfileNotFoundError,
  handymanCommonMaterialProfileReferenceInactiveError,
  handymanCommonMaterialProfileScopeMismatchError,
} from './handyman-common-material-profile.errors';
export {
  HANDYMAN_COMMON_MATERIAL_PROFILE_STATUSES,
  HANDYMAN_CUSTOMER_MATERIAL_OPTIONS,
  HANDYMAN_MATERIAL_COMMONALITIES,
  isHandymanCommonMaterialProfileStatus,
  isHandymanCustomerMaterialOption,
  isHandymanMaterialCommonality,
} from './handyman-common-material-profile.types';
export type {
  CreateHandymanCommonMaterialProfileInput,
  HandymanCommonMaterialProfileCatalogEntry,
  HandymanCommonMaterialProfileFilters,
  HandymanCommonMaterialProfileRecord,
  HandymanCommonMaterialProfileStatus,
  HandymanCustomerMaterialOption,
  HandymanMaterialCommonality,
  HandymanMaterialReferencePrice,
  HandymanMaterialReferencePriceContext,
  NewHandymanCommonMaterialProfile,
  PublicHandymanCommonMaterialProfile,
} from './handyman-common-material-profile.types';
