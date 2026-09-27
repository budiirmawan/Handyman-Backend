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
