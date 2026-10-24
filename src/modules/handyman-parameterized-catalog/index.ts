/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — parameterized Handyman service
 * catalogue module.
 *
 * The module composes existing authorities and adds no parallel engine:
 *   - the Service master is the EXISTING `service_catalog` (0321);
 *   - the Variant master is the EXISTING `handyman_service_variants` (0376);
 *   - the price authority is the EXISTING `price_catalog_entries`
 *     (0319 + 0325) — a price rule only SELECTS a governed price fact;
 *   - the quotation lifecycle is the EXISTING CR-HM-06 surface.
 */
export {
  HANDYMAN_SERVICE_ACCESS_CONDITION_SELECTOR_KEY,
  HANDYMAN_SERVICE_ACCESS_CONDITIONS,
  HANDYMAN_SERVICE_ATTRIBUTE_DATA_TYPES,
  HANDYMAN_SERVICE_PRICE_BASES,
  HANDYMAN_SERVICE_PRICING_MODES,
  HANDYMAN_SERVICE_QUOTE_OUTCOMES,
  HANDYMAN_SERVICE_RESOLUTION_REASON_CODES,
  isHandymanServiceAccessCondition,
  isHandymanServiceAttributeDataType,
  isHandymanServicePriceBasis,
  isHandymanServicePricingMode,
  isHandymanServiceQuoteOutcome,
  isHandymanServiceResolutionReasonCode,
} from './handyman-parameterized-catalog.types';
export type {
  HandymanServiceAccessCondition,
  HandymanServiceAttributeAllowedValue,
  HandymanServiceAttributeDataType,
  HandymanServiceAttributeRecord,
  HandymanServiceCategoryRecord,
  HandymanServiceCommercialProfileRecord,
  HandymanServicePriceBasis,
  HandymanServicePriceRuleRecord,
  HandymanServicePricingMode,
  HandymanServiceQuoteOutcome,
  HandymanServiceQuoteResolutionRecord,
  HandymanServiceRequestItemRecord,
  HandymanServiceResolutionReasonCode,
  HandymanServiceVariantAttributeRecord,
  PublicHandymanServiceAttribute,
  PublicHandymanServiceVariantAttribute,
  PublicHandymanServiceCategory,
  PublicHandymanServiceCommercialProfile,
  PublicHandymanServicePriceRule,
  PublicHandymanServiceQuoteResolution,
  PublicHandymanServiceRequestItem,
} from './handyman-parameterized-catalog.types';

export {
  HANDYMAN_STARTER_CATEGORIES,
  HANDYMAN_STARTER_CATEGORY_COUNT,
  HANDYMAN_STARTER_SERVICE_COUNT,
  HANDYMAN_STARTER_SERVICES,
  HANDYMAN_STARTER_UOMS,
  HANDYMAN_STARTER_VARIANT_CODE,
  HANDYMAN_STARTER_VARIANT_NAME,
} from './handyman-parameterized-catalog.starter';

export {
  addHandymanServiceVariantAttribute,
  createHandymanServiceAttribute,
  createHandymanServicePriceRule,
  getHandymanServiceCommercialProfile,
  listHandymanServiceAttributes,
  listHandymanServiceCatalogProjection,
  listHandymanServiceCategories,
  listHandymanServicePriceRules,
  listHandymanServiceVariantAttributes,
  listHandymanServiceVariants,
  updateHandymanServiceAttribute,
  updateHandymanServicePriceRule,
  updateHandymanServiceVariantAttribute,
  upsertHandymanServiceCommercialProfile,
} from './handyman-parameterized-catalog.service';
export type {
  HandymanServiceVariantProjection,
} from './handyman-parameterized-catalog.service';

export {
  importHandymanServiceCatalogStarter,
} from './handyman-parameterized-catalog-import.service';
export type {
  HandymanStarterImportCounts,
  HandymanStarterImportResult,
} from './handyman-parameterized-catalog-import.service';

export {
  composeCorrectedItemAttributes,
  composeEffectiveItemAttributes,
  loadVariantAttributeValues,
  splitItemAttributes,
} from './handyman-variant-inheritance.service';
export type {
  EffectiveItemAttributes,
  VariantAttributeValues,
} from './handyman-variant-inheritance.service';

export {
  resolveHandymanRequestItemPrice,
} from './handyman-parameterized-catalog-pricing.service';
export type {
  HandymanPriceResolutionContext,
  HandymanPriceResolutionDraft,
} from './handyman-parameterized-catalog-pricing.service';

export {
  addHandymanServiceRequestItem,
  listHandymanServiceRequestItems,
  removeHandymanServiceRequestItem,
  updateHandymanServiceRequestItem,
} from './handyman-request-items.service';

export {
  listHandymanServiceQuoteResolutions,
  prepareHandymanCatalogQuotation,
  reviseHandymanCatalogQuotation,
} from './handyman-parameterized-quotation.service';
export type {
  HandymanCatalogQuotationPrepareResult,
  HandymanCatalogQuotationStatus,
} from './handyman-parameterized-quotation.service';

export {
  handymanServiceAttributeAlreadyExistsError,
  handymanServiceAttributeInvalidError,
  handymanServiceAttributeNotFoundError,
  handymanServiceCatalogImportInvalidError,
  handymanServiceCategoryAlreadyExistsError,
  handymanServiceCategoryNotFoundError,
  handymanServiceCommercialProfileNotFoundError,
  handymanServicePriceRuleAlreadyExistsError,
  handymanServicePriceRuleCollisionError,
  handymanServicePriceRuleInvalidError,
  handymanServicePriceRuleNotFoundError,
  handymanServiceQuoteResolutionInvalidError,
  handymanServiceRequestItemInvalidError,
  handymanServiceRequestItemNotFoundError,
  handymanServiceVariantAttributeAlreadyExistsError,
  handymanServiceVariantAttributeInvalidError,
  handymanServiceVariantAttributeNotFoundError,
  handymanServiceVariantNotFoundError,
} from './handyman-parameterized-catalog.errors';

export { createHandymanParameterizedCatalogRouter } from './handyman-parameterized-catalog.routes';
export { createHandymanParameterizedQuotationRouter } from './handyman-parameterized-quotation.routes';
