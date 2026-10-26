/**
 * CR-HM-DOCUMENT-PDF-01 PART 01 + CR-HM-DOCUMENT-PROFILE-01 PARTS 01A/01B/01C —
 * the shared document seam.
 *
 * It owns exactly four things: (1) the official-document PDF LAYOUT renderer, a
 * pure snapshot -> bytes function; (2) the issuer COMPANY PROFILE master data;
 * (3) the issuer RECEIVING BANK ACCOUNT master data, where a payment destination
 * exists only after an explicit verification act; and (4) the DOCUMENT SETTINGS
 * of each official kind and language - numbering prefix namespace, standard
 * terms, payment/warranty wording, footer/contact and the authorized signatory's
 * name and title. Each master-data subject is an append-only version chain per
 * Handyman service-provider Client, exposed through a Manager-gated read/update
 * surface plus a read-only frozen snapshot resolver that documents pin.
 *
 * Still deliberately absent: document artifact persistence and download routes,
 * any storage driver or upload path (the logo stays a reference), and any
 * Quotation/BAST/Invoice/Warranty/Variation lifecycle change. A profile, a
 * payment wording block and a settings row describe how a document READS and WHO
 * it names; prices, totals, taxes, acceptance, warranty activation, consent and
 * the issued number itself belong to the owning business modules and cannot be
 * overridden from here.
 */
export { renderHandymanDocumentPdf } from './handyman-document-pdf';
export { HandymanDocumentPdfError } from './handyman-document-pdf.errors';
export {
  formatHandymanDocumentDate,
  formatHandymanDocumentInteger,
  formatHandymanDocumentMoney,
  formatHandymanDocumentQuantity,
  handymanDocumentLines,
  handymanDocumentText,
  HANDYMAN_DOCUMENT_MISSING,
} from './handyman-document-format';
export {
  createHandymanDocumentIssuerProfileRouter,
} from './handyman-document-issuer.routes';
export {
  createHandymanDocumentBankAccountRouter,
} from './handyman-document-bank.routes';
export {
  createHandymanDocumentSettingsRouter,
} from './handyman-document-settings.routes';
export {
  getHandymanDocumentSettings,
  listHandymanDocumentSettings,
  listHandymanDocumentSettingsHistory,
  resolveHandymanDocumentSettingsSnapshot,
  toPublicHandymanDocumentSettings,
  updateHandymanDocumentSettings,
  HANDYMAN_DOCUMENT_SETTINGS_HISTORY_DEFAULT_LIMIT,
  HANDYMAN_DOCUMENT_SETTINGS_HISTORY_MAX_LIMIT,
} from './handyman-document-settings.service';
export {
  handymanDocumentSettingsNotFoundError,
  handymanDocumentSettingsPrefixConflictError,
  handymanDocumentSettingsVersionConflictError,
} from './handyman-document-settings.errors';
export {
  HANDYMAN_DOCUMENT_SETTINGS_ENTITY_TYPE,
  HANDYMAN_DOCUMENT_SETTINGS_EVENT_TYPES,
  HANDYMAN_DOCUMENT_SETTINGS_FIELDS,
  HANDYMAN_DOCUMENT_SETTINGS_LANGUAGES,
  HANDYMAN_DOCUMENT_SETTINGS_KINDS,
  HANDYMAN_DOCUMENT_SETTINGS_OPTIONAL_FIELDS,
  HANDYMAN_DOCUMENT_SETTINGS_REQUIRED_FIELDS,
  HANDYMAN_DOCUMENT_SETTINGS_STATUSES,
  isHandymanDocumentSettingsKind,
  isHandymanDocumentSettingsLanguage,
} from './handyman-document-settings.types';
export type {
  HandymanDocumentSettingsContent,
  HandymanDocumentSettingsField,
  HandymanDocumentSettingsKind,
  HandymanDocumentSettingsLanguage,
  HandymanDocumentSettingsRecord,
  HandymanDocumentSettingsSnapshot,
  HandymanDocumentSettingsStatus,
  HandymanDocumentSettingsUpdateInput,
  HandymanDocumentSettingsUpdateResult,
  PublicHandymanDocumentSettings,
} from './handyman-document-settings.types';
export {
  activateHandymanDocumentBankAccount,
  createHandymanDocumentBankAccount,
  deactivateHandymanDocumentBankAccount,
  getHandymanDocumentBankAccount,
  listHandymanDocumentBankAccounts,
  listHandymanDocumentBankAccountHistory,
  resolveHandymanDocumentBankAccountSnapshot,
  toPublicHandymanDocumentBankAccount,
  updateHandymanDocumentBankAccount,
} from './handyman-document-bank.service';
export { maskHandymanDocumentAccountNumber } from './handyman-document-bank.types';
export { handymanDocumentBankAccountNotFoundError } from './handyman-document-bank.errors';
export type {
  ActivateHandymanDocumentBankAccountInput,
  CreateHandymanDocumentBankAccountInput,
  DeactivateHandymanDocumentBankAccountInput,
  HandymanDocumentBankAccountContent,
  HandymanDocumentBankAccountContentField,
  HandymanDocumentBankAccountRecord,
  HandymanDocumentBankAccountSnapshot,
  HandymanDocumentBankAccountStatus,
  HandymanDocumentBankAccountUpdateResult,
  PublicHandymanDocumentBankAccount,
  UpdateHandymanDocumentBankAccountInput,
} from './handyman-document-bank.types';
export {
  HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONTENT_FIELDS,
  HANDYMAN_DOCUMENT_BANK_ACCOUNT_ENTITY_TYPE,
  HANDYMAN_DOCUMENT_BANK_ACCOUNT_EVENT_TYPES,
  HANDYMAN_DOCUMENT_BANK_ACCOUNT_STATUSES,
  isHandymanDocumentBankAccountStatus,
} from './handyman-document-bank.types';
export {
  getHandymanDocumentIssuerProfile,
  listHandymanDocumentIssuerProfileHistory,
  resolveHandymanDocumentIssuerSnapshot,
  updateHandymanDocumentIssuerProfile,
  toPublicHandymanDocumentIssuerProfile,
  HANDYMAN_DOCUMENT_ISSUER_HISTORY_DEFAULT_LIMIT,
  HANDYMAN_DOCUMENT_ISSUER_HISTORY_MAX_LIMIT,
} from './handyman-document-issuer.service';
export {
  handymanDocumentIssuerProfileNotFoundError,
  handymanDocumentIssuerProfileVersionConflictError,
} from './handyman-document-issuer.errors';
export {
  HANDYMAN_DOCUMENT_ISSUER_PROFILE_FIELDS,
  HANDYMAN_DOCUMENT_ISSUER_PROFILE_OPTIONAL_FIELDS,
  HANDYMAN_DOCUMENT_ISSUER_PROFILE_REQUIRED_FIELDS,
  HANDYMAN_DOCUMENT_ISSUER_PROFILE_STATUSES,
  HANDYMAN_DOCUMENT_ISSUER_SNAPSHOT_ENTITY_TYPE,
  HANDYMAN_DOCUMENT_ISSUER_SNAPSHOT_EVENT_TYPES,
  isHandymanDocumentIssuerProfileStatus,
} from './handyman-document-issuer.types';
export type {
  HandymanDocumentIssuerProfileContent,
  HandymanDocumentIssuerProfileField,
  HandymanDocumentIssuerProfileRecord,
  HandymanDocumentIssuerProfileStatus,
  HandymanDocumentIssuerProfileUpdateResult,
  HandymanDocumentIssuerSnapshot,
  PublicHandymanDocumentIssuerProfile,
  UpdateHandymanDocumentIssuerProfileInput,
} from './handyman-document-issuer.types';
export {
  HANDYMAN_DOCUMENT_KINDS,
  HANDYMAN_DOCUMENT_LOCALES,
  HANDYMAN_DOCUMENT_PDF_CHECKSUM_ALGORITHM,
  HANDYMAN_DOCUMENT_PDF_CONTENT_TYPE,
  HANDYMAN_DOCUMENT_PDF_ERROR_CODES,
  HANDYMAN_DOCUMENT_PDF_LIMITS,
  isHandymanDocumentKind,
} from './handyman-document-pdf.types';
export type {
  HandymanDocumentConsentBlock,
  HandymanDocumentEvidenceRef,
  HandymanDocumentKind,
  HandymanDocumentKeyValue,
  HandymanDocumentLineItem,
  HandymanDocumentLocale,
  HandymanDocumentParty,
  HandymanDocumentPdfErrorCode,
  HandymanDocumentPdfRenderOptions,
  HandymanDocumentPdfRenderResult,
  HandymanDocumentSnapshot,
  HandymanDocumentStatusBlock,
  HandymanDocumentTermsBlock,
  HandymanDocumentTotalRow,
} from './handyman-document-pdf.types';
