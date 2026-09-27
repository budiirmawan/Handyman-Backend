/**
 * CR-HM-06 PART 01 — bounded foundation exports (FROZEN F1–F5):
 * quotation root + immutable version creation/read ONLY. No lines
 * (PART 02), no lifecycle transitions (PART 03), no approval (PART 04),
 * no execution scope (PART 05), no HTTP (PART 07A).
 */
export {
  handymanQuotationService,
  createHandymanQuotation,
  createHandymanQuotationRevision,
  getHandymanQuotation,
} from './handyman-quotation.service';
export { handymanQuotationRepository } from './handyman-quotation.repository';
export {
  handymanQuotationNotFoundError,
  handymanQuotationAlreadyExistsError,
  handymanQuotationDiagnosisRequiredError,
  handymanQuotationScopeInsufficientError,
} from './handyman-quotation.errors';
export type {
  HandymanQuotationRecord,
  HandymanQuotationVersionRecord,
  HandymanQuotationVersionStatus,
  PublicHandymanQuotation,
  PublicHandymanQuotationVersion,
  PublicHandymanQuotationBundle,
  CreateHandymanQuotationInput,
} from './handyman-quotation.types';
export {
  HANDYMAN_QUOTATION_VERSION_STATUSES,
} from './handyman-quotation.types';
export {
  addHandymanQuotationLine,
  listHandymanQuotationVersionLines,
  getHandymanQuotationVersionTotals,
} from './handyman-quotation-line.service';
export { handymanQuotationLineRepository } from './handyman-quotation-line.repository';
export {
  handymanQuotationVersionNotFoundError,
  handymanQuotationVersionNotDraftError,
  handymanQuotationLineInvalidError,
  handymanQuotationCurrencyMismatchError,
} from './handyman-quotation.errors';
export type {
  HandymanQuotationLineRecord,
  HandymanQuotationLineType,
  HandymanQuotationCurrency,
  PublicHandymanQuotationLine,
  PublicHandymanQuotationTotals,
  AddHandymanQuotationLineInput,
} from './handyman-quotation-line.types';
export {
  HANDYMAN_QUOTATION_LINE_TYPES,
  HANDYMAN_QUOTATION_CURRENCIES,
} from './handyman-quotation-line.types';
