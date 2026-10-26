/**
 * CR-HM-DOCUMENT-PDF-01 PART 01 + CR-HM-DOCUMENT-PROFILE-01 PART 01A — the
 * shared document seam.
 *
 * It owns exactly two things: (1) the official-document PDF LAYOUT renderer, a
 * pure snapshot -> bytes function; and (2) the issuer COMPANY PROFILE master
 * data (one append-only version chain per Handyman service-provider Client)
 * with its Manager-gated read/update surface and the read-only snapshot
 * resolver documents pin at render time.
 *
 * Still deliberately absent: document artifact persistence and download routes,
 * any storage driver or upload path (the logo stays a reference), and any
 * Quotation/BAST/Invoice/Warranty/Variation lifecycle change - the owning
 * business modules decide WHEN an official document exists.
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
